const TARGET_HOST = 'generativelanguage.googleapis.com';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/* Supports KEEPALIVE environment variable (enabled by default) */
const KEEPALIVE_ENABLED = typeof KEEPALIVE !== 'undefined' ? KEEPALIVE !== 'false' : true;

export default {
  /**
   * Main fetch entry point.
   * @param {Request} request
   * @param {Object} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    const url = new URL(request.url);

    // Check KEEPALIVE and streaming path
    if (KEEPALIVE_ENABLED && url.pathname.endsWith(':streamGenerateContent')) {
      return handleKeepAliveStream(request, env);
    }

    // Other requests use standard proxy
    return handleStandardProxy(request, env);
  },
};

/**
 * Standard proxy (non-stream)
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response>}
 */
async function handleStandardProxy(request, env) {
  const url = new URL(request.url);
  const targetUrl = prepareTargetUrl(url);

  const forwardRequest = new Request(targetUrl, {
    method: request.method,
    headers: new Headers(request.headers),
    body: request.body,
    redirect: 'follow',
  });

  const response = await fetch(forwardRequest);
  const mutableResponse = new Response(response.body, response);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    mutableResponse.headers.set(key, value);
  });

  return mutableResponse;
}

/**
 * Handles ':streamGenerateContent' with KEEPALIVE
 * Sends heartbeats until API responds
 * @param {Request} request
 * @param {Object} env
 * @returns {Response}
 */
function handleKeepAliveStream(request, env) {
  let heartbeatInterval;
  const encoder = new TextEncoder();
  let isProcessingComplete = false;

  // Create transform stream for client
  const transformStream = new TransformStream({
    start(controller) {
      // Send heartbeat every 2 seconds
      heartbeatInterval = setInterval(() => {
        // Send heartbeat only if processing not done
        if (!isProcessingComplete) {
          try {
            // Heartbeat event in Gemini format (client ignores blank content)
            const heartbeatData = {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: "\n\n",
                      }
                    ],
                    role: "model"
                  },
                  finishReason: "STOP",
                  index: 0,
                  safetyRatings: []
                }
              ],
              usageMetadata: {
                promptTokenCount: 0,
                candidatesTokenCount: 0,
                totalTokenCount: 0
              }
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(heartbeatData)}\n\n`));
          } catch (error) {
            console.error('Heartbeat error:', error);
            clearInterval(heartbeatInterval);
          }
        }
      }, 2000);
    },
    cancel(reason) {
      // Clear heartbeat on cancel
      clearInterval(heartbeatInterval);
      isProcessingComplete = true;
      console.log('Client disconnected:', reason);
    },
  });

  // Start async API processing (non-blocking)
  processApiRequest(request, transformStream.writable.getWriter(), heartbeatInterval, encoder, () => {
    isProcessingComplete = true;
  });

  // Return the readable side of the stream to the client immediately.
  const responseHeaders = new Headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    responseHeaders.set(key, value);
  });

  return new Response(transformStream.readable, {
    status: 200,
    headers: responseHeaders,
  });
}

/**
 * Handles actual API request asynchronously with keepalive heartbeats.
 * @param {Request} request
 * @param {WritableStreamDefaultWriter} writer
 * @param {number} heartbeatInterval
 * @param {TextEncoder} encoder
 * @param {Function} onComplete
 */
async function processApiRequest(request, writer, heartbeatInterval, encoder, onComplete) {
  try {
    // Prepare the URL for the NON-STREAMING endpoint.
    const originalUrl = new URL(request.url);
    const nonStreamingUrl = new URL(originalUrl.toString());
    nonStreamingUrl.pathname = nonStreamingUrl.pathname.replace(
      ':streamGenerateContent',
      ':generateContent'
    );
    
    const targetUrl = prepareTargetUrl(nonStreamingUrl);

    // Clone body to avoid consume errors
    const requestBody = request.body ? await request.clone().arrayBuffer() : null;

    // Make the actual, non-streaming request to Google API.
    const forwardRequest = new Request(targetUrl, {
      method: request.method,
      headers: new Headers(request.headers),
      body: requestBody,
      redirect: 'follow',
    });
    
    // Await API response (non-blocking for main stream)
    const response = await fetch(forwardRequest);

    // Mark complete, stop heartbeat
    onComplete();
    clearInterval(heartbeatInterval);

    if (!response.ok) {
      const errorText = await response.text();
      const errorData = {
        error: {
          message: `API Error: ${response.status} ${response.statusText}`,
          details: errorText
        }
      };
      await writer.write(encoder.encode(`data: ${JSON.stringify(errorData)}\n\n`));
    } else {
      // Streaming or JSON response
      const contentType = response.headers.get('content-type') || '';
      
      if (contentType.includes('text/event-stream')) {
        // Stream SSE directly
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            await writer.write(encoder.encode(chunk));
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        // Regular JSON response
        const data = await response.json();
        await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }
    }
    
    // Send completion event
    await writer.write(encoder.encode(`data: [DONE]\n\n`));
    
  } catch (error) {
    onComplete();
    clearInterval(heartbeatInterval);
    console.error('KEEPALIVE mode error:', error);
    const errorData = {
      error: {
        message: 'Worker internal error',
        details: error.message
      }
    };
    await writer.write(encoder.encode(`data: ${JSON.stringify(errorData)}\n\n`));
  } finally {
    try {
      // Close stream to client
      await writer.close();
    } catch (closeError) {
      console.error('Error closing writer:', closeError);
    }
  }
}

/**
 * Prepares API URL, randomizes key if multiple
 * @param {URL} url
 * @returns {string}
 */
function prepareTargetUrl(url) {
  const params = url.searchParams;
  const apiKeys = params.get('key');

  if (apiKeys && apiKeys.includes(',')) {
    const keyArray = apiKeys.split(',').map(k => k.trim()).filter(Boolean);
    if (keyArray.length > 0) {
      const randomKey = keyArray[Math.floor(Math.random() * keyArray.length)];
      params.set('key', randomKey);
    }
  }

  return `https://${TARGET_HOST}${url.pathname}?${params.toString()}`;
}

/**
 * Handles CORS OPTIONS requests
 * @returns {Response}
 */
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

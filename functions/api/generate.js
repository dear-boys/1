// Cloudflare Pages Function for connecting to Gemini and Image Generation APIs.
// This code runs at the edge and acts as a secure proxy for the LLM APIs.

// API URLs for Text and Image generation
const TEXT_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent";
const IMAGE_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent";
const MAX_RETRIES = 3;

// --- Helper Functions ---

/**
 * Executes a Fetch call with Exponential Backoff retry logic.
 * @param {string} url - API URL
 * @param {object} fetchOptions - Fetch options (method, body, headers)
 * @param {string} apiKey - The secure API key passed from the environment
 * @returns {Promise<object>} - JSON result from the API response
 */
async function fetchWithRetry(url, fetchOptions, apiKey) {
  let lastError = null;
  // 🔑 استفاده از کلید API دریافتی از onRequest
  const apiUrlWithKey = `${url}?key=${apiKey}`;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const response = await fetch(apiUrlWithKey, fetchOptions);
      const result = await response.json();

      if (response.ok) {
        return result;
      } else {
        lastError = result;
        if (i < MAX_RETRIES - 1) {
          // Delay using Exponential Backoff
          await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        } else {
          // Final attempt failed
          throw new Error(`API returned non-OK status. Last error: ${JSON.stringify(lastError)}`);
        }
      }
    } catch (e) {
      lastError = e.message;
      if (i < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      } else {
        // Final attempt failed
        throw new Error(`Failed after ${MAX_RETRIES} attempts. Last error: ${e.message}`);
      }
    }
  }
}

/**
 * Generates text (poem) using Gemini-2.5-Flash.
 * @param {string} prompt - User's prompt text
 * @param {string} apiKey - The secure API key
 */
async function generateText(prompt, apiKey) {
  const systemPrompt = "Act as a friendly and creative poet. Write a concise poem, up to 4 lines, in Persian.";

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
  };

  const result = await fetchWithRetry(TEXT_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, apiKey); // 🔑 کلید API به fetchWithRetry ارسال می‌شود

  const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
  
  return {
    status: "success",
    type: "text",
    prompt_sent: prompt,
    poem: generatedText || "متن تولید شده یافت نشد.",
    message_fa: "تولید متن با موفقیت انجام شد."
  };
}

/**
 * Generates an image using Gemini-2.5-Flash-Image-Preview.
 * @param {string} prompt - User's image prompt
 * @param {string} apiKey - The secure API key
 */
async function generateImage(prompt, apiKey) {
  // System instructions for image generation
  const systemPrompt = "Generate a visually appealing, artistic image based on the prompt. Focus on high detail and vibrant colors.";

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'] // Request image modality
    },
  };

  const result = await fetchWithRetry(IMAGE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, apiKey); // 🔑 کلید API به fetchWithRetry ارسال می‌شود

  // Extract base64 image data
  const imagePart = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData && p.inlineData.mimeType.startsWith('image/'));
  const base64Data = imagePart?.inlineData?.data;
  const mimeType = imagePart?.inlineData?.mimeType || 'image/png';

  if (!base64Data) {
      // Return a detailed error if no image data is found
      const blockReason = result.candidates?.[0]?.finishReason || 'Unknown';
      const promptFeedback = result.candidates?.[0]?.safetyRatings?.[0]?.probability || 'N/A';
      throw new Error(`Image generation failed. Blocked/Finish Reason: ${blockReason}, Safety: ${promptFeedback}. Check the prompt.`);
  }
  
  // Create a data URL for direct display in the browser
  const imageUrl = `data:${mimeType};base64,${base64Data}`;

  return {
    status: "success",
    type: "image",
    prompt_sent: prompt,
    image_url: imageUrl,
    mime_type: mimeType,
    message_fa: "تصویر با موفقیت تولید شد و به صورت Base64 بازگردانده شده است.",
  };
}


// --- Main Pages Function Export ---

// This function is the entry point for a Cloudflare Pages Function.
export default async function onRequest(context) {
    const request = context.request;

    // 🔑 دریافت کلید API از محیط (Environment) - این مهمترین اصلاح است
    const GEMINI_API_KEY = context.env.GEMINI_API_KEY; 

    // --- NEW: بررسی وجود کلید API ---
    if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 10) { 
        return new Response(JSON.stringify({
           status: "error",
           message_fa: "خطای پیکربندی: کلید GEMINI_API_KEY در تنظیمات Environment Variables یافت نشد یا نامعتبر است.",
           error_details: "Configuration Error: API Key not found or too short."
        }, null, 2), {
           status: 500,
           headers: { 'Content-Type': 'application/json' }
        });
    }
    // --- END NEW CHECK ---

    // --- NEW: Handle Preflight OPTIONS Request for CORS ---
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: {
                // Allow the actual request (POST) to come from any origin
                'Access-Control-Allow-Origin': '*', 
                // Allow the required headers for JSON body
                'Access-Control-Allow-Headers': 'Content-Type',
                // Allow the POST method
                'Access-Control-Allow-Methods': 'POST',
                // Cache the preflight result for 10 days
                'Access-Control-Max-Age': '86400', 
            },
        });
    }
    // --- END OPTIONS Handling ---
    
    // Check for POST method
    if (request.method !== 'POST') {
        // If it's not OPTIONS and not POST, reject it (e.g., a GET request)
        return new Response(JSON.stringify({
          status: "error",
          message_fa: "لطفاً با متد POST و بدنه JSON درخواست خود را ارسال کنید.",
        }, null, 2), {
          status: 405, // Method Not Allowed
          headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const userRequest = await request.json();
        const requestType = userRequest.type?.toLowerCase() || 'text';
        const prompt = userRequest.prompt || "";
        
        if (prompt === "") {
            return new Response(JSON.stringify({
                status: "error",
                error_details: "پرامپت نمی‌تواند خالی باشد."
            }, null, 2), {
                status: 400, // Bad Request
                headers: { 'Content-Type': 'application/json' }
            });
        }

        let responseData;

        if (requestType === 'image') {
          // 🔑 ارسال کلید API به تابع generateImage
          responseData = await generateImage(prompt, GEMINI_API_KEY);
        } else {
          // 🔑 ارسال کلید API به تابع generateText
          responseData = await generateText(prompt, GEMINI_API_KEY);
        }

        // Return the final response with the generated data
        return new Response(JSON.stringify(responseData, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": "*", // Important for CORS
          }
        });

    } catch (error) {
        // Handle Worker and API errors
        console.error("Pages Function Error:", error);
        return new Response(JSON.stringify({
          status: "error",
          message_fa: "خطا در پردازش درخواست یا فراخوانی API.",
          error_details: error.message
        }, null, 2), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
    }
}
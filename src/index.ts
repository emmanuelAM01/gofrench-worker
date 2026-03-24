// src/index.ts
// GoFrench Worker — routes /api/generate/text and /api/generate/audio
// Deployed separately from the Next.js Pages apps.
// Admin portal (admin.gofrench.com) calls this worker at api.gofrench.com

import { handleGenerateText  } from "./generate-text";
import { handleGenerateAudio } from "./generate-audio";

export interface Env {
  // OpenAI
  OPENAI_API_KEY:        string;
  OPENAI_PROMPT_ID:      string;
  OPENAI_PROMPT_VERSION?: string;

  // ElevenLabs
  ELEVENLABS_API_KEY:        string;
  ELEVENLABS_VOICE_NARRATOR: string;
  ELEVENLABS_VOICE_SOPHIE:   string;
  ELEVENLABS_VOICE_MARC:     string;
  ELEVENLABS_VOICE_CLAIRE:   string;
  ELEVENLABS_VOICE_THOMAS:   string;

  // Cloudflare R2
  R2_ACCOUNT_ID:        string;
  R2_ACCESS_KEY_ID:     string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME:       string;
  R2_PUBLIC_URL:        string;

  // Shared secret — admin portal sends this in X-Internal-Key header
  INTERNAL_SECRET: string;
}

const ALLOWED_ORIGINS = [
  "https://admin.gofrench.com",
  "https://app.gofrench.com",
];

// Return the exact request origin if it's in our allowlist.
// This avoids trailing-slash or casing mismatches that fail browser preflight checks.
function corsHeaders(origin: string | null): Record<string, string> {
  const allowed =
    origin && ALLOWED_ORIGINS.some(o => o === origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin":  allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Internal-Key",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors   = corsHeaders(origin);

    // Handle CORS preflight — must be before everything else
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Only POST allowed
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    // Auth check — all requests must include the shared secret
    const internalKey = request.headers.get("X-Internal-Key");
    if (!internalKey || internalKey !== env.INTERNAL_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/generate/text") {
      return handleGenerateText(request, env, cors);
    }

    if (url.pathname === "/api/generate/audio") {
      return handleGenerateAudio(request, env, cors);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  },
};
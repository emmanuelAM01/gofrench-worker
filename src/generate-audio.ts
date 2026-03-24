// src/generate-audio.ts
// Ported from app/api/generate/audio/route.ts
// No Next.js dependencies — plain Worker fetch handler.
// env replaces process.env everywhere.
// Speaker lines are fired in parallel for speed — narrator uses R2 cache.

import type { Env } from "./index";

// ─── Constants ────────────────────────────────────────────────────────────────

const VOICE_SETTINGS = {
  stability:         0.50,
  similarity_boost:  0.75,
  style:             0.00,
  use_speaker_boost: true,
};

const ELEVENLABS_MODEL = "eleven_multilingual_v2";

const TEF_PART_LABELS: Record<number, string> = {
  1: "conversation", 2: "annonce",   3: "message",
  4: "personne",     5: "chronique", 6: "interview",
  7: "reportage",    8: "document",
};

const FRENCH_NUMBERS: Record<number, string> = {
  1:"un", 2:"deux", 3:"trois", 4:"quatre", 5:"cinq",
  6:"six", 7:"sept", 8:"huit", 9:"neuf", 10:"dix",
  11:"onze", 12:"douze", 13:"treize", 14:"quatorze", 15:"quinze",
  16:"seize", 17:"dix-sept", 18:"dix-huit", 19:"dix-neuf", 20:"vingt",
  21:"vingt et un", 22:"vingt-deux", 23:"vingt-trois", 24:"vingt-quatre",
  25:"vingt-cinq", 26:"vingt-six", 27:"vingt-sept", 28:"vingt-huit",
  29:"vingt-neuf", 30:"trente", 31:"trente et un", 32:"trente-deux",
  33:"trente-trois", 34:"trente-quatre", 35:"trente-cinq", 36:"trente-six",
  37:"trente-sept", 38:"trente-huit", 39:"trente-neuf", 40:"quarante",
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface GenerateAudioRequest {
  exerciseId:      string;
  transcript:      string;
  voiceId:         string;
  examType:        string;
  level:           string;
  section:         number;
  questionNumber:  number;
  includeNarrator: boolean;
  voiceOverrides?: Record<number, string>;
}

interface TranscriptLine {
  speakerNumber: number;
  text: string;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleGenerateAudio(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const body: GenerateAudioRequest = await request.json();
  const { exerciseId, transcript, voiceId, examType, level, section, questionNumber, includeNarrator, voiceOverrides } = body;

  if (!env.ELEVENLABS_API_KEY) {
    return jsonError("Missing ELEVENLABS_API_KEY", 500, cors);
  }
  if (!voiceId || voiceId === "REPLACE_WITH_ELEVENLABS_ID") {
    return jsonError("voiceId not configured — update VOICES in tcf-tef-constants.ts", 400, cors);
  }

  try {
    const speakerVoiceMap: Record<number, string> = {
      0: env.ELEVENLABS_VOICE_NARRATOR,
      1: env.ELEVENLABS_VOICE_SOPHIE,
      2: env.ELEVENLABS_VOICE_MARC,
      3: env.ELEVENLABS_VOICE_CLAIRE,
      4: env.ELEVENLABS_VOICE_THOMAS,
    };

    const lines = parseTranscript(transcript);
    const lineVoices = lines.map(line => {
      const overrideVoiceId = voiceOverrides?.[line.speakerNumber];
      return overrideVoiceId || speakerVoiceMap[Math.min(line.speakerNumber, 4)] || voiceId;
    });

    // Fire narrator + all speaker lines in parallel, reassemble in order.
    // Workers have no timeout issue so this is purely for speed.
    const narratorVoiceId = speakerVoiceMap[0];
    const [narratorAudio, ...lineAudios] = await Promise.all([
      includeNarrator && narratorVoiceId
        ? getNarratorAudio(examType, section, questionNumber, narratorVoiceId, env)
        : Promise.resolve(null),
      ...lines.map((line, i) => generateLineAudio(line.text, lineVoices[i], env)),
    ]);

    const segments: Uint8Array[] = [];
    if (narratorAudio) segments.push(narratorAudio);
    segments.push(...lineAudios);

    const audioBuffer     = concatAudio(segments);
    const durationSeconds = estimateMp3Duration(audioBuffer);
    const filename        = `exercises/audio/${examType.toLowerCase()}_${level.replace("/", "-")}_${exerciseId}.mp3`;

    await uploadToR2(filename, audioBuffer, "audio/mpeg", env);

    const result = {
      exerciseId,
      audioUrl:        `${env.R2_PUBLIC_URL}/${filename}`,
      durationSeconds: Math.round(durationSeconds),
      filename:        filename.split("/").pop() ?? filename,
    };

    return new Response(JSON.stringify(result), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("[generate/audio]", err);
    return jsonError(err.message ?? String(err), 500, cors);
  }
}

// ─── Narrator cache (R2) ──────────────────────────────────────────────────────
// Short fixed strings — generate once, store in R2, reuse forever.
// No timeout risk here since Workers have no wall-clock limit.

function narratorCacheKey(examType: string, section: number, questionNumber: number): string {
  const type = examType.toLowerCase();
  const part = examType === "TEF" ? `p${section}` : `s${section}`;
  return `${type}_${part}_q${questionNumber}`;
}

function buildNarratorIntro(examType: string, section: number, questionNumber: number): string {
  const qWord = FRENCH_NUMBERS[questionNumber] ?? String(questionNumber);
  if (examType === "TEF") {
    const label = TEF_PART_LABELS[section] ?? "document";
    return `Question ${qWord}, ${label} ${qWord}.`;
  }
  return `Question ${qWord}.`;
}

async function getNarratorAudio(
  examType: string,
  section: number,
  questionNumber: number,
  narratorVoiceId: string,
  env: Env
): Promise<Uint8Array> {
  const { AwsClient } = await import("aws4fetch");
  const key      = narratorCacheKey(examType, section, questionNumber);
  const filename = `exercises/audio/narrator/${key}.mp3`;
  const url      = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${filename}`;

  const aws = new AwsClient({
    accessKeyId:     env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region:          "auto",
    service:         "s3",
  });

  // Cache hit — reuse stored narrator clip
  try {
    const headRes = await aws.fetch(url, { method: "HEAD" });
    if (headRes.ok) {
      const getRes = await aws.fetch(url, { method: "GET" });
      if (getRes.ok) return new Uint8Array(await getRes.arrayBuffer());
    }
  } catch {}

  // Cache miss — generate and store
  const introText  = buildNarratorIntro(examType, section, questionNumber);
  const audioBytes = await generateLineAudio(introText, narratorVoiceId, env);

  try {
    await uploadToR2(filename, audioBytes, "audio/mpeg", env);
  } catch (e) {
    console.warn("[narrator cache] upload failed, continuing:", e);
  }

  return audioBytes;
}

// ─── ElevenLabs ───────────────────────────────────────────────────────────────

async function generateLineAudio(text: string, voiceId: string, env: Env): Promise<Uint8Array> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key":   env.ELEVENLABS_API_KEY,
      "Accept":       "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id:       ELEVENLABS_MODEL,
      voice_settings: VOICE_SETTINGS,
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ─── R2 upload ────────────────────────────────────────────────────────────────

async function uploadToR2(key: string, body: Uint8Array, contentType: string, env: Env): Promise<void> {
  const { AwsClient } = await import("aws4fetch");
  const url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET_NAME}/${key}`;
  const aws = new AwsClient({
    accessKeyId:     env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    region:          "auto",
    service:         "s3",
  });
  const res = await aws.fetch(url, {
    method:  "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(body.byteLength) },
    body:    body.buffer as ArrayBuffer,
  });
  if (!res.ok) throw new Error(`R2 upload failed ${res.status}: ${await res.text()}`);
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function parseTranscript(transcript: string): TranscriptLine[] {
  const lines      = transcript.split("\n").map(l => l.trim()).filter(Boolean);
  const tagPattern = /^\[SPEAKER_(\d+)\]\s+(.+)$/;
  return lines.map(line => {
    const match = line.match(tagPattern);
    if (!match) return { speakerNumber: 1, text: line };
    return { speakerNumber: parseInt(match[1], 10), text: match[2] };
  });
}

function concatAudio(segments: Uint8Array[]): Uint8Array {
  const total  = segments.reduce((s, b) => s + b.length, 0);
  const out    = new Uint8Array(total);
  let   offset = 0;
  for (const seg of segments) { out.set(seg, offset); offset += seg.length; }
  return out;
}

function estimateMp3Duration(buf: Uint8Array): number {
  const audioBytes = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33
    ? buf.length - 200
    : buf.length;
  return Math.max(1, audioBytes / 16000);
}

function jsonError(msg: string, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
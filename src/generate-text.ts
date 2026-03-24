// src/generate-text.ts
// Ported from app/api/generate/text/route.ts
// No Next.js dependencies — plain Worker fetch handler.
// env replaces process.env everywhere.

import type { Env } from "./index";

// ─── Types ────────────────────────────────────────────────────────────────────

interface GenerationSpec {
  mode:                    string;
  examType:                string;
  level:                   string;
  section:                 number;
  documentType:            string;
  topic:                   string;
  trapType:                string;
  imageMode:               "none" | "question" | "choices";
  speakerCount:            number;
  targetAudioLengthSeconds: number;
  questionsPerAudio:       number;
  answerChoiceCount:       number;
  linguisticParams: {
    communicativeObjective:   string;
    typicalSituations:        string;
    vocabulary:               string;
    grammarAndTenses:         string;
    syntax:                   string;
    speechRate:               string;
    pronunciationAndFluency:  string;
    cognitiveLoad:            string;
  };
  regenReason?: string;
}

interface GenerateTextRequest {
  specs:   GenerationSpec[];
  batchId: string;
}

interface OpenAIAnswerChoice {
  index:    number;
  text:     string | null;
  imageUrl: string | null;
}

interface OpenAIQuestion {
  position:         number;
  questionText:     string;
  questionImageUrl: string | null;
  imagePrompt:      string | null;
  answerChoices:    OpenAIAnswerChoice[];
  correctIndex:     number;
  explanation:      string;
}

interface OpenAIExerciseResponse {
  transcript: string;
  questions:  OpenAIQuestion[];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function handleGenerateText(
  request: Request,
  env: Env,
  cors: Record<string, string>
): Promise<Response> {
  const body: GenerateTextRequest = await request.json();
  const { specs, batchId } = body;

  if (!env.OPENAI_API_KEY)   return jsonError("Missing OPENAI_API_KEY",   500, cors);
  if (!env.OPENAI_PROMPT_ID) return jsonError("Missing OPENAI_PROMPT_ID", 500, cors);

  const encoder = new TextEncoder();

  // Stream one NDJSON line per exercise as it completes.
  // Workers have no wall-clock timeout on paid plans — long runs are fine.
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < specs.length; i++) {
        try {
          const exercise = await generateOneExercise(specs[i], i, batchId, env);
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: "exercise", exercise }) + "\n")
          );
        } catch (err: any) {
          controller.enqueue(
            encoder.encode(JSON.stringify({ type: "error", index: i, error: err.message ?? String(err) }) + "\n")
          );
        }
      }
      controller.enqueue(
        encoder.encode(JSON.stringify({ type: "done", batchId }) + "\n")
      );
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      ...cors,
      "Content-Type":  "application/x-ndjson",
      "Cache-Control": "no-cache",
    },
  });
}

// ─── Generate one exercise ────────────────────────────────────────────────────

async function generateOneExercise(
  spec: GenerationSpec,
  index: number,
  batchId: string,
  env: Env
): Promise<object> {
  const promptInput = {
    exam_type:                   spec.examType,
    level:                       spec.level,
    section:                     String(spec.section),
    document_type:               spec.documentType,
    topic:                       spec.topic,
    trap_type:                   spec.trapType,
    image_mode:                  spec.imageMode,
    speaker_count:               String(spec.speakerCount),
    target_audio_length_seconds: String(spec.targetAudioLengthSeconds),
    questions_per_audio:         String(spec.questionsPerAudio),
    answer_choice_count:         String(spec.answerChoiceCount),
    communicative_objective:     spec.linguisticParams.communicativeObjective,
    typical_situations:          spec.linguisticParams.typicalSituations,
    vocabulary:                  spec.linguisticParams.vocabulary,
    grammar_and_tenses:          spec.linguisticParams.grammarAndTenses,
    syntax:                      spec.linguisticParams.syntax,
    speech_rate:                 spec.linguisticParams.speechRate,
    pronunciation_and_fluency:   spec.linguisticParams.pronunciationAndFluency,
    cognitive_load:              spec.linguisticParams.cognitiveLoad,
    regen_reason:                spec.regenReason ?? "",
    past_feedback:               "No previous feedback for this section.",
  };

  const openaiRes = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      prompt: {
        id:        env.OPENAI_PROMPT_ID,
        ...(env.OPENAI_PROMPT_VERSION ? { version: env.OPENAI_PROMPT_VERSION } : {}),
        variables: promptInput,
      },
    }),
  });

  if (!openaiRes.ok) {
    const err = await openaiRes.text();
    throw new Error(`OpenAI error ${openaiRes.status}: ${err}`);
  }

  const openaiData = await openaiRes.json() as any;
  const messageBlock = (openaiData?.output ?? []).find((o: any) => o.type === "message");
  const rawText: string = messageBlock?.content?.[0]?.text ?? "";
  if (!rawText) throw new Error("Empty response from OpenAI");

  let parsed: OpenAIExerciseResponse;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`OpenAI returned non-JSON: ${rawText.slice(0, 200)}`);
  }

  // Images — only for exam mode (practice always imageMode: "none")
  const processedQuestions = await Promise.all(
    parsed.questions.map(async (q) => {
      let questionImageUrl = q.questionImageUrl;

      if (spec.imageMode === "question" && q.imagePrompt && !questionImageUrl) {
        questionImageUrl = await generateAndUploadImage(q.imagePrompt, `${batchId}_e${index}_q${q.position}`, env);
      }

      const answerChoices = await Promise.all(
        q.answerChoices.map(async (choice) => {
          if (spec.imageMode === "choices" && q.imagePrompt && !choice.imageUrl) {
            let choicePrompts: string[] = [];
            try { choicePrompts = JSON.parse(q.imagePrompt ?? "[]"); } catch {}
            const choicePrompt = choicePrompts[choice.index];
            if (choicePrompt) {
              const imageUrl = await generateAndUploadImage(
                choicePrompt,
                `${batchId}_e${index}_q${q.position}_c${choice.index}`,
                env
              );
              return { ...choice, imageUrl };
            }
          }
          return choice;
        })
      );

      return {
        id:               `q_${batchId}_${index}_${q.position}`,
        position:         q.position,
        questionText:     q.questionText,
        questionImageUrl: questionImageUrl ?? null,
        imagePrompt:      q.imagePrompt    ?? null,
        answerChoices,
        correctIndex:     q.correctIndex,
        explanation:      q.explanation,
      };
    })
  );

  return {
    id:         `pe_${batchId}_${index}`,
    transcript: parsed.transcript,
    questions:  processedQuestions,
    spec: {
      examType:                 String(spec.examType),
      level:                    spec.level,
      section:                  spec.section,
      documentType:             spec.documentType,
      topic:                    spec.topic,
      trapType:                 spec.trapType,
      imageMode:                spec.imageMode,
      speakerCount:             spec.speakerCount,
      targetAudioLengthSeconds: spec.targetAudioLengthSeconds,
      questionsPerAudio:        spec.questionsPerAudio,
      answerChoiceCount:        spec.answerChoiceCount,
      voiceId:                  "",
    },
  };
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

// ─── DALL·E image generation ──────────────────────────────────────────────────

async function generateAndUploadImage(prompt: string, key: string, env: Env): Promise<string> {
  const dalleRes = await fetch("https://api.openai.com/v1/images/generations", {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: "dall-e-3", prompt, n: 1, size: "1024x1024", response_format: "b64_json", style: "natural", quality: "standard" }),
  });
  if (!dalleRes.ok) throw new Error(`DALL·E error ${dalleRes.status}: ${await dalleRes.text()}`);
  const dalleData = await dalleRes.json() as any;
  const b64 = dalleData?.data?.[0]?.b64_json as string;
  if (!b64) throw new Error("DALL·E returned no image data");
  const imageBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const filename   = `exercises/images/${key}.png`;
  await uploadToR2(filename, imageBytes, "image/png", env);
  return `${env.R2_PUBLIC_URL}/${filename}`;
}

// ─── Util ─────────────────────────────────────────────────────────────────────

function jsonError(msg: string, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
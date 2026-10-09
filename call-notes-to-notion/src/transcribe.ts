import { defaultFetch, type FetchLike } from "./notion";

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TranscribeError";
  }
}

export interface TranscribeArgs {
  apiKey: string;
  model: string;
  language: string;
  audio: ArrayBuffer;
  filename: string;
  contentType: string;
  /** Context die de spelling van namen helpt (bv. "Telefoongesprek met Peter Kraan van Improvery"). */
  prompt?: string;
  fetchImpl?: FetchLike;
}

/**
 * Transcribeert audio via OpenAI (`gpt-4o-transcribe` standaard). Nederlands wordt
 * expliciet meegegeven; `chunking_strategy: auto` laat de server lange opnames
 * zelf in stukken knippen. Limiet: 25 MB per bestand.
 */
export async function transcribe(args: TranscribeArgs): Promise<string> {
  const fetchImpl = args.fetchImpl ?? defaultFetch;
  const form = new FormData();
  form.append("file", new Blob([args.audio], { type: args.contentType }), args.filename);
  form.append("model", args.model);
  form.append("language", args.language);
  form.append("response_format", "json");
  form.append("chunking_strategy", "auto");
  if (args.prompt) form.append("prompt", args.prompt);

  const res = await fetchImpl("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new TranscribeError(`OpenAI transcriptie mislukt (${res.status}): ${text.slice(0, 300)}`, res.status);
  }
  let json: { text?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new TranscribeError(`OpenAI gaf geen geldige JSON terug: ${text.slice(0, 200)}`, 502);
  }
  const transcript = (json.text ?? "").trim();
  if (!transcript) throw new TranscribeError("Transcript is leeg (stilte of onverstaanbare audio?)", 422);
  return transcript;
}

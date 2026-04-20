import { updateRuntimeState } from "../core/runtime.js";

async function readStdinJson(): Promise<Record<string, unknown>> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  const text = Buffer.concat(chunks).toString("utf-8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function runHookSessionStart(runId: string, statePath: string): Promise<number> {
  const payload = await readStdinJson();
  updateRuntimeState(statePath, runId, {
    session_id: payload["session_id"] ? String(payload["session_id"]) : undefined,
    cwd: payload["cwd"] ? String(payload["cwd"]) : undefined,
  });
  return 0;
}

export async function runHookPromptSubmit(runId: string, statePath: string): Promise<number> {
  const payload = await readStdinJson();
  const prompt = payload["prompt"];
  const promptText = prompt ? String(prompt) : null;
  const detectorArmed = Boolean(promptText && !promptText.trimStart().startsWith("/"));
  updateRuntimeState(statePath, runId, {
    session_id: payload["session_id"] ? String(payload["session_id"]) : undefined,
    cwd: payload["cwd"] ? String(payload["cwd"]) : undefined,
    last_prompt: promptText ?? undefined,
    last_prompt_at: new Date().toISOString(),
    detector_armed: detectorArmed,
  });
  return 0;
}

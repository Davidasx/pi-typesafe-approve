/** Pi's classifier API, using the host's providers and request-time authentication. */
import { isRecord, parsePiModel } from "./config.ts";
import { normalizeResponse, SystemOneError } from "./systemone.ts";
import type { JevQuestion, StructuredValue, SystemOneResponse } from "./types.ts";

interface PiClassifierModel {
  type: "classifier";
  provider: string;
  id: string;
}

/** Small compatibility surface: direct mode still works on Pi versions predating classifiers. */
interface PiClassifierRegistry {
  getModelOfType(type: "classifier", provider: string, modelId: string): PiClassifierModel | undefined;
  classify(
    model: PiClassifierModel,
    context: {
      state: Record<string, unknown>;
      questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
    },
    options: { signal: AbortSignal; timeoutMs: number; maxRetries: number },
  ): Promise<unknown>;
}

/** No discovery, model substitution, direct HTTP fallback, or credential extraction. */
export async function askPi(
  registryValue: unknown,
  selector: string,
  request: { state: StructuredValue; questions: Record<string, JevQuestion> },
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<SystemOneResponse> {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    let identity: ReturnType<typeof parsePiModel>;
    try {
      identity = parsePiModel(selector);
    } catch {
      throw new SystemOneError("invalid", 'Pi model must be "provider/modelId", e.g. "openrouter/typesafe/jev-1.14"');
    }
    const { provider, modelId } = identity;
    const registry = registryValue as Partial<PiClassifierRegistry> | undefined;
    if (typeof registry?.getModelOfType !== "function" || typeof registry.classify !== "function") {
      throw new SystemOneError("invalid", "Pi classifier API is unavailable; use Pi 0.99.0 or newer for the pi backend");
    }
    const model = registry.getModelOfType("classifier", provider, modelId);
    if (!model) throw new SystemOneError("invalid", `Pi classifier not found: ${selector.trim()}`);
    if (!isRecord(request.state)) throw new Error("Pi classifier state must be an object");

    // Pi's portable API accepts string criteria, unlike native System One's structured values.
    const questions: Parameters<PiClassifierRegistry["classify"]>[1]["questions"] = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type !== "choice") throw new Error("The Pi backend expects a choice question");
      questions[id] = {
        type: "choice",
        instructions: asText(question.instructions),
        criteria: Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, asText(value)])),
      };
    }

    // Enforce a total deadline too: timeoutMs in Pi's transport is per attempt.
    signal.throwIfAborted();
    const result = await withAbort(
      registry.classify(model, { state: request.state, questions }, {
        signal,
        timeoutMs: options.timeoutMs,
        maxRetries: 0,
      }),
      signal,
    );
    if (!isRecord(result) || result.stopReason !== "stop") {
      throw new Error(isRecord(result) && typeof result.errorMessage === "string"
        ? result.errorMessage
        : "Pi classifier did not return a successful result");
    }
    const usage = isRecord(result.usage) ? result.usage : undefined;
    const cost = usage && isRecord(usage.cost) ? usage.cost.total : undefined;
    // Keep the full provider/model identity and the existing strict answer validation.
    return normalizeResponse({
      model: selector.trim(),
      answers: result.answers,
      ...(usage ? { usage: { input_tokens: usage.input, output_tokens: usage.output, cost } } : {}),
    }, request.questions);
  } catch (error) {
    if (timeout.aborted && !options.signal?.aborted) {
      throw new SystemOneError("timeout", `request timed out after ${options.timeoutMs}ms`);
    }
    // Do not expose provider error bodies: credentials are owned by Pi and unavailable for redaction here.
    if (options.signal?.aborted) throw new SystemOneError("network", "Pi classification was aborted");
    if (error instanceof SystemOneError) throw error;
    throw new SystemOneError("invalid", "Pi classification failed; check the selected model and its provider authentication in Pi");
  }
}

function asText(value: StructuredValue | null): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

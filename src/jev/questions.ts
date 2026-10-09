/** Jev tier question set (v1) — identical to the F1 offline eval (anymodel-route jev/questions-tier-v1.json). */
export const JEV_MODEL = 'jev-1.13.0';
export const JEV_PRICE_USD_PER_MTOK_INPUT = 0.042;
export const JEV_TIERS = ['trivial', 'light', 'moderate', 'heavy', 'intensive', 'extreme'] as const;
export type JevTier = (typeof JEV_TIERS)[number];
export const JEV_TIER_QUESTIONS = {
  "tier": {
    "type": "choice",
    "instructions": "Classify the effort tier that the request in `task` needs from an AI model, using the GateSwarm effort-level definitions below. Judge the work the request asks for. The request may be written in Portuguese or English.",
    "criteria": {
      "trivial": "Greetings, simple facts, yes/no questions. Examples: \"hi\", \"2+2\", \"what time is it\".",
      "light": "Short Q&A, summaries, formatting. Examples: \"summarize this\", \"fix typos\".",
      "moderate": "Analysis, explanations, code review. Examples: \"explain this function\", \"review this code\".",
      "heavy": "Code generation, multi-constraint tasks. Examples: \"write an API endpoint with auth\", \"design a schema\".",
      "intensive": "Complex systems, architecture. Examples: \"design a microservice architecture\", \"plan migration strategy\".",
      "extreme": "Novel generation, deep reasoning. Examples: \"build a distributed system from scratch\", \"create a new framework\"."
    }
  }
} as const;

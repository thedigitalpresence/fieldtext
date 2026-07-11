import { test } from "node:test";
import assert from "node:assert/strict";
import { looksAmbiguous } from "../intents";
import type { ParseResult } from "../types";

const r = (actions: any[], needs?: string): ParseResult => ({ actions, needs_clarification: needs } as ParseResult);

test("looksAmbiguous: gates shaky / self-contradictory parses", () => {
  // The reported case: "add Mitch to reminder quote now" -> a bare collect_field
  // update mixed with a reminder. Must ask, not guess.
  assert.equal(looksAmbiguous(r([
    { intent: "update_client_info", confidence: 0.6, collect_field: "note" },
    { intent: "set_reminder", confidence: 0.6 },
  ])), true);

  // Nothing confident at all.
  assert.equal(looksAmbiguous(r([{ intent: "log_quote", confidence: 0.3 }])), true);

  // Two different intents where one leg is shaky.
  assert.equal(looksAmbiguous(r([
    { intent: "log_payment", confidence: 0.9 },
    { intent: "set_reminder", confidence: 0.4 },
  ])), true);
});

test("looksAmbiguous: lets confident and normal parses through", () => {
  // Clear single action.
  assert.equal(looksAmbiguous(r([{ intent: "log_quote", confidence: 0.9 }])), false);
  // Legit confident multi-action ("quoted Jane $200, remind me Friday").
  assert.equal(looksAmbiguous(r([
    { intent: "log_quote", confidence: 0.9 },
    { intent: "set_reminder", confidence: 0.85 },
  ])), false);
  // Pure query/help is never gated (has its own soft handling).
  assert.equal(looksAmbiguous(r([{ intent: "query", confidence: 0.3 }])), false);
  assert.equal(looksAmbiguous(r([])), false);
});

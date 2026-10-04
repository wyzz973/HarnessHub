// SPDX-License-Identifier: MIT
/**
 * The route-group rules and members as HarnessHub reads them, for clients
 * that edit groups (the console): the same parser, checks and words as the
 * daemon and `hh group rule`, so an editor marks the word the daemon would
 * refuse. Pure, and needs no Node module.
 */
export {
  cleanRule,
  faultySpans,
  MAX_INTENT,
  MAX_RULES,
  parseRule,
  RULE_KEYS,
  ruleConditions,
  ruleKey,
  ruleLine,
  RuleSyntaxError,
  ruleWords,
  ruleWordSpans,
  type RuleProblem,
  type RuleWord,
  type TypedRule,
} from "@harnesshub/core/route-rules";
export {
  FAST_SUFFIX,
  GROUP_NEST_LIMIT,
  memberText,
  parseGroupMember,
  type GroupMember,
} from "@harnesshub/core/route-groups";
export {
  reasoningEfforts,
  ruleEfforts,
  weekdays,
} from "@harnesshub/core/model-refs";

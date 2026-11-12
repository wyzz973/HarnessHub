import { FileConversationStore, type FileConversationStoreOptions } from "../../src/infrastructure/session/file-store.js";
import { recoverConversation } from "../../src/contexts/session/domain/conversation-state.js";
import { recoverConversationRelay } from "../../src/contexts/session/domain/relay/recover.js";

/*
 * The store a Gateway owns, opened as the application opens it (src/cli/session-application.ts): the real tables on a real data root, with the domain's recovery of
 * a conversation an earlier owner left unfinished and of the relay deliveries it left in flight. The store knows no rule of the domain and is given these; a test that
 * wants a store without them passes its own (or none) in `options`. Only the Harness and the model are made up in the tests that use it.
 */
export function appStore(root: string, options: FileConversationStoreOptions = {}): FileConversationStore {
  return new FileConversationStore(root, { recover: recoverConversation, recoverRelay: recoverConversationRelay, ...options });
}

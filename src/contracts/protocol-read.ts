import type { ItemBase, ProtocolItem, ProtocolTurn } from "./protocol.js";

/**
 * What a client keeps of an item whose type it does not know (a later protocol's, or one it could not read whole): one line
 * that says so, never a dropped item (docs/proposals/protocol/hub-protocol.html §6). Only a client's decoder makes one; the Hub
 * never sends this type, so no producer has to know it.
 */
export interface UnrecognizedItem extends ItemBase { readonly type: "unrecognized"; readonly nativeType: string }

/** An item as a client reads it: the protocol's own, or the line kept for one it could not read. */
export type ReadItem = ProtocolItem | UnrecognizedItem;

/** A Turn as a client reads it: the protocol's Turn, with room for the lines kept for unread items. */
export interface ReadTurn extends Omit<ProtocolTurn, "items"> { readonly items: readonly ReadItem[] }

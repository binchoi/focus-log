// Gives Dexie a real IndexedDB implementation under Node so the store and
// outbox can be tested without a browser.
import "fake-indexeddb/auto";

// structuredClone is used to persist CryptoKey objects into IndexedDB. Node 22
// has it globally, but assert it so a downgrade fails loudly here rather than
// silently in a store test.
if (typeof structuredClone !== "function") {
  throw new Error("structuredClone is required (Node 17+)");
}

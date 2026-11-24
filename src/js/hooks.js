// Late-bound cross-module hooks (avoids circular imports). Filled in by app.js.
export const hooks = {
  openAI: null, // (ids) => void
  openDocFill: null, // (typeKey, id, fileRef?) => void
  openPrompts: null,
  openSettings: null, // (tab) => void
  render: null,
};

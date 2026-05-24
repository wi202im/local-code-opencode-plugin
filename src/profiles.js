export function splitModelID(model) {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerID: "", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

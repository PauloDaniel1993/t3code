const SENSITIVE_FIELD =
  /(?:^|_)(?:authorizations?|cookies?|credentials?|passwords?|passwds?|secrets?|tokens?|(?:api|private|secret|access)_keys?)$/;
const QUANTITY_FIELD =
  /(?:^|_)(?:max|min|total|num|count)_(?:authorizations|cookies|credentials|passwords|passwds|secrets|tokens)$/;
export function sensitiveField(key: string): boolean {
  // Common content/type/text fields need no word-splitting allocations on the pump.
  if (!/authorization|cookie|credential|password|passwd|secret|token|key/i.test(key)) return false;
  const words = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return SENSITIVE_FIELD.test(words) && !QUANTITY_FIELD.test(words);
}

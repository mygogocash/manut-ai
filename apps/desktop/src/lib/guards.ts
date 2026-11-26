// Reading JSON that came from outside (the host, a file, a stored setting) means never trusting its shape. These are
// the checks the parsing modules had each written for themselves, kept here so they all agree on what an object is.

/** A plain object: not null, not an array. */
export const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

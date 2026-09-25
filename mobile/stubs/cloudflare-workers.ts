// The hosted coordinator (app/api/control) imports `cloudflare:workers` for its D1 binding.
// A static mobile export still compiles that module even though it never prerenders or
// serves it, and the phone has no Worker runtime to resolve the import against. This stub
// satisfies the bundler. Reaching any of it at runtime would mean the phone was trying to
// be the coordinator, which is not a thing it can do, so the getter fails loudly.
export const env = new Proxy({} as Record<string, unknown>, {
  get(_target, property) {
    throw new Error(`The hosted coordinator binding "${String(property)}" is not available in the mobile app. Phones talk to a coordinator over HTTPS; they do not host one.`);
  },
});
const workers = { env };
export default workers;

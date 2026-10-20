/**
 * Browser-visible Supabase settings.
 *
 * There is no build step, so Netlify environment variables are NOT available
 * to this file. Paste the values from the Supabase dashboard into the object
 * below, then commit or deploy the updated file.
 *
 * Where to copy them (Supabase Dashboard):
 *   Project Settings → API
 *     Project URL              → url
 *     anon public / publishable → anonKey
 *
 * NEVER put the service_role key or the database password in this file
 * (or in any other frontend file). Those secrets bypass Row Level Security.
 */
window.LEAVING_CARD_SUPABASE = {
  url: "https://yhnxzjpfrlusfddlizor.supabase.co",
  anonKey: "sb_publishable_emVv35DwXs1WxJicJ-HQow_nuJfG3Rg",
};

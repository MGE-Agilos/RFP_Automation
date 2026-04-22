// ─── Supabase Configuration ──────────────────────────────────
// Fill in your Supabase project URL and anon key.
// Both values are safe to expose in the frontend (anon key is public by design).
// Find them in: Supabase Dashboard → Project Settings → API

const SUPABASE_URL  = "https://YOUR_PROJECT_ID.supabase.co";
const SUPABASE_ANON = "YOUR_ANON_KEY";

// Edge function base URL (same as SUPABASE_URL/functions/v1)
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

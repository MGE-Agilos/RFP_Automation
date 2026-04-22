// ─── Supabase Configuration ──────────────────────────────────
// Fill in your Supabase project URL and anon key.
// Both values are safe to expose in the frontend (anon key is public by design).
// Find them in: Supabase Dashboard → Project Settings → API

const SUPABASE_URL  = "https://vxwmhsgxoomcbiukeinp.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ4d21oc2d4b29tY2JpdWtlaW5wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyNTMwODUsImV4cCI6MjA5MTgyOTA4NX0.DYfan7mRM0dYkB9xouBjb2Y1ONdmZxByrsr29nSZuAE";

// Edge function base URL (same as SUPABASE_URL/functions/v1)
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

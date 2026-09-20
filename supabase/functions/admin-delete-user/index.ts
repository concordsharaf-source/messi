import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authorization = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: { user: actor } } = await userClient.auth.getUser();
    if (!actor) return json({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const { data: actorProfile } = await adminClient.from("profiles").select("is_admin").eq("id", actor.id).maybeSingle();
    if (!actorProfile?.is_admin) return json({ error: "Admin only" }, 403);

    const { userId } = await req.json();
    if (!userId || userId === actor.id) return json({ error: "Invalid target" }, 400);
    const { data: target } = await adminClient.from("profiles").select("is_admin").eq("id", userId).maybeSingle();
    if (!target || target.is_admin) return json({ error: "Only ordinary users can be deleted" }, 403);

    const { data: conversations, error: conversationsError } = await adminClient.from("conversations").select("id").eq("user_id", userId);
    if (conversationsError) throw conversationsError;
    const ids = (conversations || []).map((row) => row.id);
    if (ids.length) {
      const { error } = await adminClient.from("messages").delete().in("conversation_id", ids);
      if (error) throw error;
    }
    const { error: conversationsDeleteError } = await adminClient.from("conversations").delete().eq("user_id", userId);
    if (conversationsDeleteError) throw conversationsDeleteError;
    const { error: tokensError } = await adminClient.from("fcm_tokens").delete().eq("user_id", userId);
    if (tokensError) throw tokensError;
    const { error: profileError } = await adminClient.from("profiles").delete().eq("id", userId);
    if (profileError) throw profileError;
    const { error: authError } = await adminClient.auth.admin.deleteUser(userId);
    if (authError) throw authError;
    return json({ success: true });
  } catch (error) {
    console.error("admin-delete-user error", error);
    return json({ error: error?.message || "Delete failed" }, 500);
  }
});

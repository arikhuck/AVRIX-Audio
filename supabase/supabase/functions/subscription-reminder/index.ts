import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const resendApiKey = Deno.env.get('RESEND_API_KEY') ?? ''
    const appUrl = Deno.env.get('APP_URL') || 'https://arikhuck.github.io/AVRIX-Audio'
    const pricingUrl = `${appUrl}/index.html#pricing`

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: "Missing server environment variables" }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)
    const now = new Date()

    // 1. NONAKTIFKAN OTOMATIS LISENSI YANG SUDAH KADALUARSA
    const { data: expiredProfiles, error: expireErr } = await supabaseAdmin
      .from('profiles')
      .update({ subscription_status: 'expired', updated_at: now.toISOString() })
      .eq('is_lifetime', false)
      .eq('subscription_status', 'active')
      .lt('subscription_expiry', now.toISOString())
      .select('id, email, subscription_expiry')

    if (expireErr) {
      console.error("Error expiring profiles:", expireErr)
    } else {
      console.log(`Deactivated ${expiredProfiles?.length || 0} expired subscriptions.`)
    }

    // 2. CARI USER DENGAN MASA AKTIF H-3 (KECUALI LIFETIME)
    // Tiga hari dari sekarang
    const threeDaysLater = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000)

    const { data: expiringSoon, error: queryErr } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('is_lifetime', false)
      .eq('subscription_status', 'active')
      .gte('subscription_expiry', now.toISOString())
      .lte('subscription_expiry', threeDaysLater.toISOString())

    if (queryErr) {
      throw queryErr
    }

    console.log(`Found ${expiringSoon?.length || 0} users expiring in <= 3 days.`)
    const sentList: string[] = []

    for (const profile of (expiringSoon || [])) {
      // Pastikan belum pernah dikirim reminder untuk siklus masa aktif saat ini
      const lastReminder = profile.reminder_sent_for_expiry ? new Date(profile.reminder_sent_for_expiry) : null
      const expiry = new Date(profile.subscription_expiry)

      // Jika sudah dikirim dalam 4 hari terakhir sebelum expiry, lewati
      if (lastReminder && (expiry.getTime() - lastReminder.getTime()) <= 4 * 24 * 60 * 60 * 1000) {
        console.log(`User ${profile.email} already received reminder recently. Skipping.`)
        continue
      }

      const diffDays = Math.max(1, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
      const formattedDate = expiry.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })

      const emailSubject = `Reminder: Your AVRIX Audio License Expires in ${diffDays} Days`
      const emailHtml = `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; color: #1e293b;">
          <div style="background: linear-gradient(135deg, #0369a1 0%, #075985 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
            <h1 style="margin: 0; font-size: 24px; font-weight: 900; letter-spacing: 1.5px;">AVRIX AUDIO</h1>
            <p style="margin: 6px 0 0 0; font-size: 12px; color: #bae6fd; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">Studio Mixing Assistant</p>
          </div>
          <div style="padding: 32px 28px;">
            <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 800; color: #0f172a;">Your license will expire soon</h2>
            <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
              Hi <strong>${profile.full_name || profile.email}</strong>,<br><br>
              This is a quick reminder that your <strong>AVRIX Audio</strong> subscription will expire in <strong>${diffDays} days</strong> on <strong>${formattedDate}</strong>.
            </p>

            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 18px; margin: 24px 0;">
              <p style="margin: 0; font-size: 13px; color: #92400e; font-weight: 600; line-height: 1.5;">
                To prevent any interruption in your audio mixing workflows and retain full access to Preset Engine and Mode Learn (WAV Intelligence), please renew your license before it expires.
              </p>
            </div>

            <div style="text-align: center; margin: 32px 0 24px 0;">
              <a href="${pricingUrl}" style="display: inline-block; background: linear-gradient(180deg, #0284c7 0%, #0369a1 100%); color: #ffffff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 800; font-size: 14px; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);">
                Renew Your License Now &rarr;
              </a>
            </div>

            <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #e2e8f0;">
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #334155;">
                Best regards,<br>
                <strong style="color: #0f172a; font-size: 15px;">Ari Gunawan</strong><br>
                <span style="color: #0284c7; font-size: 12px; font-weight: 700; text-transform: uppercase;">Creator, AVRIX Audio</span>
              </p>
            </div>
          </div>
          <div style="background: #f1f5f9; padding: 16px 24px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px solid #e2e8f0;">
            &copy; 2026 AVRIX Audio. All rights reserved.
          </div>
        </div>
      `

      if (resendApiKey) {
        try {
          const fromEmail = Deno.env.get('RESEND_FROM_EMAIL') || 'AVRIX Audio <onboarding@resend.dev>'
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${resendApiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [profile.email],
              subject: emailSubject,
              html: emailHtml
            })
          })
          console.log(`Reminder email sent to ${profile.email}`)
        } catch (mailErr) {
          console.error(`Failed to send reminder email to ${profile.email}:`, mailErr)
        }
      }

      // Update reminder_sent_for_expiry
      await supabaseAdmin
        .from('profiles')
        .update({ reminder_sent_for_expiry: now.toISOString() })
        .eq('id', profile.id)

      sentList.push(profile.email)
    }

    return new Response(
      JSON.stringify({
        success: true,
        deactivated_expired: expiredProfiles?.length || 0,
        reminders_sent: sentList.length,
        recipients: sentList
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error("Subscription reminder error:", err)
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

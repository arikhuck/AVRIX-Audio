import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey)

    // Parse Webhook Payload
    const payload = await req.json()
    console.log("=== MAYAR WEBHOOK RECEIVED ===")
    console.log(JSON.stringify(payload, null, 2))

    // Validasi Event / Status dari Mayar
    const event = (payload.event || payload.action || '').toString().toLowerCase()
    const status = (payload.data?.status || payload.status || '').toString().toUpperCase()

    const isSuccessfulPayment = 
      event === 'payment.received' || 
      event === 'payment.success' || 
      event === 'transaction.success' || 
      status === 'SUCCESS' || 
      status === 'PAID'

    if (!isSuccessfulPayment) {
      console.log(`Event ignored: event=${event}, status=${status}`)
      return new Response(
        JSON.stringify({ message: "Event ignored (not a successful payment event)" }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Ambil Email Pelanggan (mendukung berbagai format payload Mayar)
    const rawCustomerEmail = 
      payload.data?.customerEmail || 
      payload.data?.customer?.email || 
      payload.customerEmail || 
      payload.data?.email || 
      payload.email

    if (!rawCustomerEmail) {
      console.error("Customer email not found in payload:", payload)
      return new Response(
        JSON.stringify({ error: "Email pelanggan tidak ditemukan dalam payload Mayar" }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const cleanEmail = rawCustomerEmail.trim().toLowerCase()
    const customerName = 
      payload.data?.customerName || 
      payload.data?.customer?.name || 
      payload.customerName || 
      payload.data?.name || 
      ''

    const amount = Number(payload.data?.amount ?? payload.amount ?? 0)
    const productName = payload.data?.productName || payload.productName || payload.data?.description || ''
    const productId = payload.data?.productId || payload.productId || ''
    const transactionId = 
      payload.data?.transactionId || 
      payload.data?.id || 
      payload.transactionId || 
      payload.id || 
      `trx_${Date.now()}`

    // 1. Tentukan Paket Lisensi & Durasi Berdasarkan Produk / Amount
    // 1 Month = ~Rp 10.000 | 1 Year = ~Rp 100.000 | Lifetime = ~Rp 150.000
    let tier: '1_month' | '1_year' | 'lifetime' = '1_month'
    let isLifetime = false
    let daysToAdd = 30

    const lowerText = `${productName} ${productId}`.toLowerCase()

    if (lowerText.includes('lifetime') || lowerText.includes('forever') || amount >= 140000) {
      tier = 'lifetime'
      isLifetime = true
      daysToAdd = 0
    } else if (lowerText.includes('year') || lowerText.includes('tahunan') || amount >= 90000) {
      tier = '1_year'
      isLifetime = false
      daysToAdd = 365
    } else {
      tier = '1_month'
      isLifetime = false
      daysToAdd = 30
    }

    console.log(`Identified Plan: Tier=${tier}, isLifetime=${isLifetime}, daysToAdd=${daysToAdd}, Amount=${amount}`)

    // 2. Cari Akun User di Supabase Database (profiles terlebih dahulu, lalu auth.users)
    let targetUserId: string | null = null
    let targetUserEmail: string = cleanEmail
    let existingProfile: any = null

    // Cek di tabel profiles
    const { data: profileData, error: profileFetchErr } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .ilike('email', cleanEmail)
      .maybeSingle()

    if (!profileFetchErr && profileData) {
      existingProfile = profileData
      targetUserId = profileData.id
      targetUserEmail = profileData.email
      console.log(`User found in profiles table: ID=${targetUserId}`)
    } else {
      // Fallback: Cek di auth.users jika baris profiles belum dibuat
      console.log(`User not found in profiles, checking auth.users for ${cleanEmail}...`)
      const { data: { users }, error: listUsersErr } = await supabaseAdmin.auth.admin.listUsers()
      if (!listUsersErr && users) {
        const found = users.find(u => u.email?.toLowerCase() === cleanEmail)
        if (found) {
          targetUserId = found.id
          targetUserEmail = found.email || cleanEmail
          console.log(`User found in auth.users: ID=${targetUserId}`)
        }
      }
    }

    // 3. Jika User Belum Terdaftar (Fallback untuk skema Auth-First)
    if (!targetUserId) {
      console.warn(`User ${cleanEmail} belum terdaftar di Supabase Auth. Menyimpan ke pending_licenses...`)

      // Simpan ke pending_licenses agar otomatis aktif begitu user mendaftar
      await supabaseAdmin.from('pending_licenses').insert({
        email: cleanEmail,
        tier: tier,
        is_lifetime: isLifetime,
        days_to_add: daysToAdd,
        transaction_id: transactionId,
        claimed: false
      })

      // Catat ke riwayat log pembayaran
      await supabaseAdmin.from('payment_logs').insert({
        user_id: null,
        email: cleanEmail,
        amount: amount,
        product_name: productName || tier,
        tier: tier,
        transaction_id: transactionId,
        event_type: event,
        status: 'PENDING_REGISTRATION',
        raw_payload: payload
      })

      return new Response(
        JSON.stringify({
          success: true,
          pending: true,
          message: `Pembayaran diterima. User ${cleanEmail} belum terdaftar, lisensi disimpan di antrean pending dan akan aktif otomatis saat user mendaftar.`
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. Hitung Tanggal Kedaluwarsa Lisensi (Akumulatif jika user memperpanjang sebelum expired)
    let newExpiryISO: string | null = null

    if (!isLifetime) {
      const now = new Date()
      let baseDate = now

      // Jika lisensi saat ini masih aktif, tambahkan dari expiry yang ada
      if (existingProfile?.subscription_expiry) {
        const currentExp = new Date(existingProfile.subscription_expiry)
        if (currentExp > now) {
          baseDate = currentExp
          console.log(`Extending existing active subscription from ${baseDate.toISOString()}`)
        }
      }

      const expiryDate = new Date(baseDate)
      expiryDate.setDate(expiryDate.getDate() + daysToAdd)
      newExpiryISO = expiryDate.toISOString()
    }

    // 5. Update tabel PROFILES di Supabase
    const { error: updateError } = await supabaseAdmin
      .from('profiles')
      .upsert({
        id: targetUserId,
        email: targetUserEmail,
        full_name: customerName || existingProfile?.full_name || targetUserEmail.split('@')[0],
        subscription_tier: tier,
        subscription_status: 'active',
        subscription_expiry: newExpiryISO,
        is_lifetime: isLifetime,
        last_payment_date: new Date().toISOString(),
        last_transaction_id: transactionId,
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' })

    if (updateError) {
      console.error("Error updating profiles table:", updateError)
      throw updateError
    }

    // Auto-confirm user email upon successful payment so customer can log in immediately
    if (targetUserId) {
      try {
        const updateAttrs: any = { email_confirm: true }
        if (payload.testPassword) {
          updateAttrs.password = payload.testPassword
        }
        await supabaseAdmin.auth.admin.updateUserById(targetUserId, updateAttrs)
        console.log(`User ${targetUserId} email confirmed and ready for login.`)
      } catch (confirmErr) {
        console.warn("Auto-confirm notice:", confirmErr)
      }
    }

    // 6. Catat Transaksi Sukses ke tabel PAYMENT_LOGS
    await supabaseAdmin.from('payment_logs').insert({
      user_id: targetUserId,
      email: cleanEmail,
      amount: amount,
      product_name: productName || tier,
      tier: tier,
      transaction_id: transactionId,
      event_type: event,
      status: 'SUCCESS',
      raw_payload: payload
    })

    // 7. Kirim Email Otomatis ke Customer yang Berhasil Membeli
    const resendApiKey = Deno.env.get('RESEND_API_KEY') || ''
    const appUrl = Deno.env.get('APP_URL') || 'https://avrixaudio.site'
    const studioUrl = `${appUrl}/plugin.html`

    const formattedExpiry = isLifetime 
      ? 'Lifetime (Permanent Access)' 
      : (newExpiryISO ? new Date(newExpiryISO).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' }) : '30 Days')

    const tierDisplayName = 
      tier === 'lifetime' ? 'Lifetime Access' :
      tier === '1_year' ? '1 Year Access' : '1 Month Access'

    const emailSubject = `Welcome to AVRIX Studio – Your License is Active! [${tierDisplayName}]`
    const emailHtml = `
      <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 580px; margin: 0 auto; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; color: #1e293b;">
        <div style="background: linear-gradient(135deg, #0369a1 0%, #075985 100%); padding: 32px 24px; text-align: center; color: #ffffff;">
          <h1 style="margin: 0; font-size: 24px; font-weight: 900; letter-spacing: 1.5px;">AVRIX AUDIO</h1>
          <p style="margin: 6px 0 0 0; font-size: 12px; color: #bae6fd; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;">Acoustic Engine & Dynamic Compression Advisor</p>
        </div>
        <div style="padding: 32px 28px;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 800; color: #0f172a;">Thank you for your purchase!</h2>
          <p style="margin: 0 0 20px 0; font-size: 14px; line-height: 1.6; color: #475569;">
            Hi <strong>${customerName || targetUserEmail}</strong>,<br><br>
            Thank you for investing in <strong>AVRIX Audio</strong>. Your payment via Mayar has been verified, and your license is now active and linked directly to your account.
          </p>

          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin: 24px 0;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Plan / License:</td>
                <td style="padding: 6px 0; color: #0369a1; font-weight: 800; text-align: right;">${tierDisplayName}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Active Until:</td>
                <td style="padding: 6px 0; color: #059669; font-weight: 800; text-align: right;">${formattedExpiry}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Account Email:</td>
                <td style="padding: 6px 0; color: #0f172a; font-weight: 700; text-align: right;">${targetUserEmail}</td>
              </tr>
              <tr>
                <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Transaction ID:</td>
                <td style="padding: 6px 0; color: #475569; font-size: 11px; text-align: right;">${transactionId}</td>
              </tr>
            </table>
          </div>

          <div style="text-align: center; margin: 32px 0 24px 0;">
            <a href="${studioUrl}" style="display: inline-block; background: linear-gradient(180deg, #0284c7 0%, #0369a1 100%); color: #ffffff; padding: 14px 32px; border-radius: 12px; text-decoration: none; font-weight: 800; font-size: 14px; box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35);">
              Launch AVRIX Studio &rarr;
            </a>
          </div>

          <p style="margin: 20px 0 0 0; font-size: 13px; line-height: 1.6; color: #64748b;">
            Preset Engine and Mode Learn (WAV Intelligence) are now completely unlocked for you. If you need any mixing assistance or guidance, feel free to reply directly to this email.
          </p>

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
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [cleanEmail],
            subject: emailSubject,
            html: emailHtml
          })
        })
        const emailData = await emailRes.json()
        console.log("Customer receipt email sent successfully via Resend:", emailData)
      } catch (emailErr) {
        console.error("Failed to send customer email via Resend:", emailErr)
      }
    } else {
      console.log("Note: RESEND_API_KEY is not set in Supabase Secrets. Customer email template generated for:", cleanEmail)
    }

    console.log(`Success! Lisensi ${tier} aktif untuk ${targetUserEmail} hingga ${newExpiryISO ?? 'LIFETIME'}`)

    return new Response(
      JSON.stringify({
        success: true,
        message: `Lisensi AVRIX Audio (${tier}) berhasil diaktifkan untuk ${targetUserEmail}`,
        details: {
          email: targetUserEmail,
          tier: tier,
          is_lifetime: isLifetime,
          expiry: newExpiryISO,
          transaction_id: transactionId
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error("Webhook processing exception:", error)
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

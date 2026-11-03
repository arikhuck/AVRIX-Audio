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

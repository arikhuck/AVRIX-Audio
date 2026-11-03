-- ==========================================================
-- AVRIX Audio - Supabase Database Schema (Idempotent & Safe)
-- Eksekusi file SQL ini di Supabase SQL Editor
-- (Dashboard -> Project -> SQL Editor -> New Query -> Run)
-- ==========================================================

-- 1. Pastikan Tabel PROFILES ada
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

-- 2. Tambahkan semua kolom lisensi secara aman (Safe Migration jika tabel sudah pernah dibuat)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT 'none'; -- 'none', '1_month', '1_year', 'lifetime'
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'inactive'; -- 'inactive', 'active', 'expired'
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS subscription_expiry TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_lifetime BOOLEAN DEFAULT FALSE;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_payment_date TIMESTAMPTZ;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS last_transaction_id TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now());
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now());

-- Isi email dari auth.users jika sebelumnya belum ada
UPDATE public.profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id AND (p.email IS NULL OR p.email = '');

-- Index pencarian email cepat
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(lower(email));

-- 3. Buat Tabel PAYMENT_LOGS (Riwayat Transaksi Mayar)
CREATE TABLE IF NOT EXISTS public.payment_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    amount NUMERIC,
    product_name TEXT,
    tier TEXT,
    transaction_id TEXT,
    event_type TEXT,
    status TEXT DEFAULT 'SUCCESS',
    raw_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Index transaksi
CREATE INDEX IF NOT EXISTS idx_payment_logs_email ON public.payment_logs(lower(email));
CREATE INDEX IF NOT EXISTS idx_payment_logs_trx ON public.payment_logs(transaction_id);

-- 4. Buat Tabel PENDING_LICENSES (Fallback jika pembayaran masuk sebelum registrasi)
CREATE TABLE IF NOT EXISTS public.pending_licenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    tier TEXT NOT NULL,
    is_lifetime BOOLEAN DEFAULT FALSE,
    days_to_add INTEGER DEFAULT 30,
    transaction_id TEXT,
    claimed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_licenses_email ON public.pending_licenses(lower(email));

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_licenses ENABLE ROW LEVEL SECURITY;

-- Policy Profiles: User hanya bisa membaca profil mereka sendiri
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" 
ON public.profiles FOR SELECT 
TO authenticated 
USING (auth.uid() = id);

-- Policy Profiles: User bisa update nama profil mereka sendiri
DROP POLICY IF EXISTS "Users can update own basic profile" ON public.profiles;
CREATE POLICY "Users can update own basic profile" 
ON public.profiles FOR UPDATE 
TO authenticated 
USING (auth.uid() = id)
WITH CHECK (auth.uid() = id);

-- Policy Payment Logs: User bisa membaca riwayat pembayaran mereka
DROP POLICY IF EXISTS "Users can view own payment logs" ON public.payment_logs;
CREATE POLICY "Users can view own payment logs" 
ON public.payment_logs FOR SELECT 
TO authenticated 
USING (auth.uid() = user_id);

-- Catatan: Service Role (Edge Function / Mayar Webhook) otomatis bypass RLS dengan SUPABASE_SERVICE_ROLE_KEY.

-- 6. FUNCTION & TRIGGER: Auto create profil & claim pending lisensi saat user Register
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
    pending_row RECORD;
    v_expiry TIMESTAMPTZ := NULL;
    v_tier TEXT := 'none';
    v_status TEXT := 'inactive';
    v_lifetime BOOLEAN := FALSE;
    v_trx TEXT := NULL;
BEGIN
    -- Cek apakah ada pembayaran tertunda untuk email ini
    SELECT * INTO pending_row 
    FROM public.pending_licenses 
    WHERE lower(email) = lower(new.email) AND claimed = FALSE 
    ORDER BY created_at DESC 
    LIMIT 1;

    IF FOUND THEN
        v_tier := pending_row.tier;
        v_lifetime := pending_row.is_lifetime;
        v_trx := pending_row.transaction_id;
        v_status := 'active';

        IF NOT v_lifetime THEN
            v_expiry := now() + (pending_row.days_to_add || ' days')::interval;
        END IF;

        -- Tandai pembayaran sudah diklaim
        UPDATE public.pending_licenses 
        SET claimed = TRUE 
        WHERE id = pending_row.id;
    END IF;

    -- Insert ke profiles
    INSERT INTO public.profiles (
        id, 
        email, 
        full_name, 
        subscription_tier, 
        subscription_status, 
        subscription_expiry, 
        is_lifetime, 
        last_transaction_id,
        created_at, 
        updated_at
    )
    VALUES (
        new.id, 
        new.email, 
        COALESCE(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
        v_tier, 
        v_status, 
        v_expiry, 
        v_lifetime, 
        v_trx,
        now(), 
        now()
    )
    ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
        updated_at = now();

    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Pasang Trigger ke auth.users
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- 7. Sync user yang sudah terlanjur register sebelum tabel/kolom dibuat
INSERT INTO public.profiles (id, email, full_name, subscription_tier, subscription_status, created_at, updated_at)
SELECT 
    id, 
    email, 
    COALESCE(raw_user_meta_data->>'full_name', split_part(email, '@', 1)),
    'none',
    'inactive',
    created_at, 
    now()
FROM auth.users
ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(public.profiles.full_name, EXCLUDED.full_name),
    updated_at = now();

-- Sign in with CoinPay, Postgres. See migrations/global/0004_coinpay.sql.

create table if not exists coinpay_identities (
  sub text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  email text,
  name text,
  created_at text NOT NULL,
  last_login_at text
);

create table if not exists coinpay_pending (
  id text PRIMARY KEY,
  verifier text NOT NULL,
  nonce text NOT NULL,
  next_path text NOT NULL,
  link_user_id text,
  expires_at text NOT NULL,
  created_at text NOT NULL
);

alter table user_tokens add column if not exists payload text;

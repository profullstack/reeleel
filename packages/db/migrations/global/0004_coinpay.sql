-- Sign in with CoinPay (CoinPay is the fleet's master account).
--
-- An account is bound to a CoinPay identity by its `sub`, never by email:
-- CoinPay does not verify addresses, so its email is kept here as contact
-- information only and never written to users.email.

create table if not exists coinpay_identities (
  sub            text primary key,
  user_id        text not null unique references users(id) on delete cascade,
  email          text,
  name           text,
  created_at     text not null,
  last_login_at  text
);

-- One row per authorization request in flight: the PKCE verifier and nonce
-- never leave the server, and the row is deleted the first time it is used.
create table if not exists coinpay_pending (
  id            text primary key,
  verifier      text not null,
  nonce         text not null,
  next_path     text not null,
  link_user_id  text,
  expires_at    text not null,
  created_at    text not null
);

-- An address a CoinPay-only account asked to use, proven by the link mailed
-- to it before it becomes users.email.
alter table user_tokens add column payload text;

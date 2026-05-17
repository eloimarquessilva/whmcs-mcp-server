-- ===========================================================================
-- scrub-pii.sql — applied to a DISPOSABLE staging DB loaded from the raw
-- prod dump, BEFORE any data is loaded into the local WHMCS containers.
--
-- Mandated (user): replace ALL emails + phone numbers with dummies AND
-- anonymize client/contact names, companies, addresses, tax ids, ticket
-- requester names, and ALL custom field values. No real client identity
-- data is retained.
-- Best practice (user-approved): neutralize secrets, truncate sensitive
-- logs / card data / API device credentials, reset admin to a known dev
-- login.
--
-- Idempotent (safe to re-run). __ADMIN_PWHASH__ is substituted by
-- seed-from-prod.sh with a freshly computed bcrypt hash.
-- Run with --force so an optional table/column missing on a given WHMCS
-- minor does not abort the mandated core scrubs (which run first).
-- ===========================================================================

SET SESSION sql_mode = '';
SET FOREIGN_KEY_CHECKS = 0;

-- ---- MANDATED: emails → dev+<id>@example.test, phones → +10000000000 ----
UPDATE tblclients   SET email = CONCAT('dev+', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tblclients   SET phonenumber = '+10000000000'
                       WHERE phonenumber IS NOT NULL AND phonenumber <> '';
UPDATE tblcontacts  SET email = CONCAT('dev+c', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tblcontacts  SET phonenumber = '+10000000000'
                       WHERE phonenumber IS NOT NULL AND phonenumber <> '';
UPDATE tblusers     SET email = CONCAT('dev+u', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tblticketreplies SET email = CONCAT('dev+tr', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';
UPDATE tbltickets   SET email = CONCAT('dev+tk', id, '@example.test')
                       WHERE email IS NOT NULL AND email <> '';

-- ---- ANONYMIZE names / companies / addresses / tax ids ----
-- Deterministic by id (distinct entities still look distinct, but fake).
-- Kept as SEPARATE single-purpose statements so a column that is absent on
-- a given WHMCS minor (skipped under --force) cannot cause the identity
-- columns to go un-scrubbed.
UPDATE tblclients  SET firstname = CONCAT('Client', id), lastname = 'Test';
UPDATE tblclients  SET companyname = CONCAT('Test Co ', id);
UPDATE tblclients  SET address1 = CONCAT('Addr ', id), address2 = '',
                       city = 'Testville', state = 'TS', postcode = '00000';
UPDATE tblclients  SET taxid = '';   -- optional column
UPDATE tblclients  SET notes = '';   -- optional column (admin notes)
UPDATE tblcontacts SET firstname = CONCAT('Contact', id), lastname = 'Test';
UPDATE tblcontacts SET companyname = CONCAT('Test Co ', id);
UPDATE tblcontacts SET address1 = CONCAT('Addr ', id), address2 = '',
                       city = 'Testville', state = 'TS', postcode = '00000';
UPDATE tblusers    SET firstname = CONCAT('User', id), lastname = 'Test';
UPDATE tbltickets  SET name = CONCAT('Requester', id)
                       WHERE name IS NOT NULL AND name <> '';
-- Custom field values can hold arbitrary submitted PII → blank all.
UPDATE tblcustomfieldsvalues SET value = '' WHERE value <> '';

-- ---- TRUNCATE high-risk PII / secret logs + card data ----
TRUNCATE TABLE tblcreditcards;
TRUNCATE TABLE tblemails;
TRUNCATE TABLE tblgatewaylog;
TRUNCATE TABLE tblactivitylog;
TRUNCATE TABLE tbladminlog;
TRUNCATE TABLE tblapilog;
TRUNCATE TABLE tbldeviceauth;   -- modern WHMCS API credential store (prod identifiers + bcrypt secrets)
TRUNCATE TABLE tblnotes;        -- free-text client notes may contain PII

-- ---- Blank gateway / server / config secrets ----
UPDATE tblpaymentgateways
  SET value = ''
  WHERE setting REGEXP '(?i)(secret|password|apikey|api_key|privatekey|private_key|signature|token|publishable|clientid|client_secret|webhook)';
UPDATE tblconfiguration
  SET value = ''
  WHERE setting REGEXP '(?i)(password|secret|apikey|api_key|privatekey|private_key|token|smtppass)';
UPDATE tblservers
  SET password = '', accesshash = ''
  WHERE 1 = 1;

-- ---- Reset to a single known DEV admin (creds documented in runbook) ----
-- Keep the lowest-id admin, scrub PII + 2FA, set a known bcrypt password.
-- WHMCS 8.x/9.x verifies the admin login against `passwordhash` (the
-- `password` column alone is NOT sufficient — both must be set). And
-- password_reset_data/expiry are NOT NULL columns: assigning NULL aborts
-- the whole UPDATE (and under `mysql --force` it is silently SKIPPED, so
-- the admin keeps prod creds). Set both hash columns; only clear the
-- reset *key* (leave the NOT NULL reset_data/expiry untouched).
UPDATE tbladmins
  SET username     = 'admin',
      email        = 'devadmin@example.test',
      password     = '__ADMIN_PWHASH__',
      passwordhash = '__ADMIN_PWHASH__',
      authmodule   = '',
      authdata     = '',
      password_reset_key = '',
      loginattempts = 0,
      disabled   = 0
  WHERE id = (SELECT mid FROM (SELECT MIN(id) AS mid FROM tbladmins) z);
DELETE FROM tbladmins
  WHERE id <> (SELECT mid FROM (SELECT MIN(id) AS mid FROM tbladmins) z);

-- ---- Let the External API authenticate from localhost ----
-- tbldeviceauth (the modern API credential store) is TRUNCATED above, so
-- prod API identifiers/secrets never reach the local DB. Local dev must
-- mint a fresh credential (see replicate-cred.sh). The legacy
-- tblapi_credentials (older minors) only needs its IP allowlist cleared.
UPDATE tblapi_credentials SET ip_restriction = '' WHERE 1 = 1;

-- ---- Disable CAPTCHA for local dev (decompiled captcha.tpl shows the
-- gate is isEnabled()=CaptchaSetting AND isEnabledForForm()=CaptchaForms;
-- blanking only the provider keys falls back to the built-in image
-- captcha, so we kill all three gates).
UPDATE tblconfiguration SET value = 'off' WHERE setting = 'CaptchaSetting';
UPDATE tblconfiguration SET value = '{}'  WHERE setting = 'CaptchaForms';
UPDATE tblconfiguration SET value = ''
  WHERE setting IN ('ReCAPTCHAPublicKey','ReCAPTCHAPrivateKey',
                    'hCaptchaPublicKey','hCaptchaPrivateKey');

SET FOREIGN_KEY_CHECKS = 1;

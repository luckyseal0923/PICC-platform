"use strict";
window.PICC_CONFIG = {
  // Runtime /assets/config.js loads public settings from the Coolify website service.
  supabaseUrl: "",
  // Only the publishable/anon key may be placed here. Never use service_role.
  // Leave blank to run the isolated local demonstration.
  supabaseAnonKey: "",
  trialMode: true,
  // Current self-hosted Auth version needs a separately verified LINE login setup.
  authProvider: "",
  // Enable only for approved development test accounts.
  testAuthEnabled: false
};

"use strict";
window.PICC_CONFIG = {
  // Kong HTTPS API of the Zeabur PICC-booking project.
  supabaseUrl: "https://picc-booking.zeabur.app",
  // Only the publishable/anon key may be placed here. Never use service_role.
  // Leave blank to run the isolated local demonstration.
  supabaseAnonKey: "",
  // Current self-hosted Auth version needs a separately verified LINE login setup.
  authProvider: "",
  // Enable only for approved development test accounts.
  testAuthEnabled: false
};

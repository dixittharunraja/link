// Release builds use the GUI subsystem so Windows opens no console window alongside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // The installer registers this executable as a small service for the Second Screen display.
  if std::env::args().nth(1).as_deref() == Some(app_lib::DISPLAY_SERVICE_ARG) {
    app_lib::run_display_service();
    return;
  }
  app_lib::run();
}

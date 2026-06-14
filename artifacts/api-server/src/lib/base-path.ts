// BASE_PATH is the URL prefix under which this Express app is mounted.
//
// On Replit the reverse proxy routes /api/* to this server and Express also
// sees the /api prefix (routes are registered with app.use("/api", ...)).
// BASE_PATH defaults to "/api" to match that layout.
//
// On Render (or any plain host with no reverse-proxy prefix) the app should
// listen at root.  Set BASE_PATH="" in your environment variables to enable
// root-mounted mode.
export const BASE_PATH: string = process.env["BASE_PATH"] ?? "/api";

# WP-BOT — Personal WhatsApp AI Agent

A personal WhatsApp Web auto-reply agent powered by Google Gemini.

## Architecture

- **Windows PC:** runs `whatsapp-web.js`, Chrome/Puppeteer, Gemini, the WhatsApp session, and the local data store.
- **Vercel:** hosts the optional remote dashboard in `dashboard/`.
- **Dashboard → Windows:** requests are authenticated with `x-control-token`.

The WhatsApp worker must remain running on the Windows PC. Vercel does not run the persistent WhatsApp Web/Puppeteer process.

## Windows setup

1. Copy `.env.example` to `.env`.
2. Add your Gemini API key.
3. Generate a long random `CONTROL_TOKEN` and keep it secret.
4. Run `npm install` and `npm start`.
5. Scan the QR shown in the terminal with WhatsApp → Linked devices.
6. The local dashboard remains available at `http://localhost:3000`.

## Remote dashboard

Deploy the `dashboard` directory as a separate Vercel project with **Root Directory = `dashboard`**.

The dashboard asks for the public HTTPS URL of your Windows backend and the same `CONTROL_TOKEN` configured on Windows.

Never put `GEMINI_API_KEY`, WhatsApp session files, or `.wwebjs_auth` in Vercel.

## Windows backend access

For remote access, use a secure HTTPS tunnel or reverse proxy. Do not expose port 3000 directly to the public internet without HTTPS and authentication.

## Important

This project uses WhatsApp Web automation for a personal account. Review WhatsApp's current terms and policies before relying on automation.

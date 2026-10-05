# Relay Standalone Backend

## Deployment Instructions (Render)

This backend is designed to run as a standalone Node.js server. 

### Steps to Deploy:
1. Create a new Web Service on Render.
2. Connect your repository.
3. Set the Environment to **Node**.
4. Set the Build Command to: `npm install`
5. Set the Start Command to: `npm start` (or `node server.js`)

### Required Environment Variables:
You must define the following environment variables in the Render dashboard:
- `PORT`: (Render will set this automatically)
- `RELAY_EXTENSION_ID`: The exact Chrome extension ID permitted to access this API.
- `GITHUB_TOKEN`: A valid GitHub token used server-side to fetch PM Context and repositories.
- `GOOGLE_API_KEY`: A valid Gemini API key used server-side to generate AI responses.

> **Important**: Never commit your `.env` file or expose these secrets to the public repository.

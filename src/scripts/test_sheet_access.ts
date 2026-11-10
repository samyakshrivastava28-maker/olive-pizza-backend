import dotenv from 'dotenv';
dotenv.config();
import { adminDb as db } from '../config/firebase.js';
import { google } from 'googleapis';

function getSheetsClient() {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
  let authClient: any;

  if (serviceAccountJson) {
    const decoded = JSON.parse(Buffer.from(serviceAccountJson, 'base64').toString('utf-8'));
    console.log('Using Service Account Email:', decoded.client_email);
    authClient = new google.auth.JWT({
      email: decoded.client_email,
      key: decoded.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
    });
  }
  return google.sheets({ version: 'v4', auth: authClient });
}

async function testAccess() {
  const sheets = getSheetsClient();
  const spreadsheetId = '1dOeUjDaQRUPyWhGxyu_6xLh4zxiuiB73fOekYpigbaY';
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId });
    console.log('✅ Connected to Spreadsheet:', res.data.properties?.title);
    console.log('Existing Sheets:', res.data.sheets?.map(s => s.properties?.title));
  } catch (err: any) {
    console.error('❌ Error accessing spreadsheet:', err.message);
  }
}

testAccess();

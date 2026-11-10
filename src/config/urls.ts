import dotenv from 'dotenv';
dotenv.config();

// Centralized Frontend & Backend URL configuration
export const FRONTEND_URL = process.env.FRONTEND_URL 
  || (process.env.NODE_ENV === 'production' ? 'https://olivepizza.in' : 'https://olivepizza.in');

export const API_BASE = process.env.BACKEND_URL || process.env.API_BASE
  || (process.env.NODE_ENV === 'production' ? 'https://api.olivepizza.in' : 'https://api.olivepizza.in');


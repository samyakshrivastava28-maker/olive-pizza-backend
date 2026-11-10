const cloudinary = require('cloudinary').v2;
const dotenv = require('dotenv');
dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dxmlvkff1',
  api_key: process.env.CLOUDINARY_API_KEY || '881318315911963',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'u7eGeV4PM7jeVHUiNk82hOkEKeo',
});

async function test() {
  try {
    const res = await cloudinary.api.resources({
      type: 'upload',
      prefix: 'olive-pizza',
      max_results: 50,
    });
    console.log('Cloudinary resources count:', res.resources?.length);
    if (res.resources?.length > 0) {
      console.log('Sample image URL:', res.resources[0].secure_url);
    }
  } catch (e) {
    console.error('Cloudinary error:', e.message);
  }
}

test();

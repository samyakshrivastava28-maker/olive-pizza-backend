import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendOrderReceipt = async (toEmail: string, orderData: any) => {
  try {
    const itemsHtml = orderData.items.map((item: any) => 
      `<li>${item.quantity}x ${item.name} (${item.size}) - ₹${item.price * item.quantity}</li>`
    ).join('');

    const html = `
      <div style="font-family: sans-serif; max-w-lg mx-auto p-4">
        <h1 style="color: #658c3a;">Olive Pizza</h1>
        <h2>Order Received! (${orderData.dailyOrderNumber || `#${orderData.id.slice(-6).toUpperCase()}`})</h2>
        <p>Thank you for ordering with Olive Pizza. We're preparing your order now.</p>
        
        <h3>Order Summary:</h3>
        <ul>${itemsHtml}</ul>
        
        <p><strong>Subtotal:</strong> ₹${orderData.totalAmount}</p>
        <p><strong>Delivery Fee:</strong> ₹40</p>
        <p><strong>Total:</strong> ₹${orderData.totalAmount + 40}</p>

        <h3>Delivery Details:</h3>
        <p>${orderData.deliveryAddress.addressLine}</p>
        <p>Phone: ${orderData.contactPhone}</p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || 'Olive Pizza <noreply@olivepizza.app>',
      to: toEmail,
      subject: `Your Olive Pizza Order ${orderData.dailyOrderNumber || `#${orderData.id.slice(-6).toUpperCase()}`}`,
      html,
    });

    // Send alert to owner
    if (process.env.OWNER_EMAIL) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'Olive Pizza <noreply@olivepizza.app>',
        to: process.env.OWNER_EMAIL,
        subject: `NEW ORDER ALERT: ${orderData.dailyOrderNumber || `#${orderData.id.slice(-6).toUpperCase()}`}`,
        html: `A new order has been placed. <br><br> ${html}`,
      });
    }

  } catch (error) {
    console.error('Failed to send order emails:', error);
  }
};

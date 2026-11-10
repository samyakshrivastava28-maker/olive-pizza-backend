import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

class EmailService {
  private transporter: nodemailer.Transporter;
  private readonly brandColor = '#658c3a';
  private readonly logoUrl = 'https://res.cloudinary.com/dxmlvkff1/image/upload/v1782376898/olive-pizza/brand/logo.png';

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_PORT === '465',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  private wrapHtml(title: string, content: string) {
    return `
      <div style="font-family: 'Inter', sans-serif; max-width: 600px; margin: 0 auto; background-color: #f8fafc; padding: 20px; border-radius: 12px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="${this.logoUrl}" alt="Olive Pizza" style="height: 60px;" />
          <h1 style="color: ${this.brandColor}; margin: 10px 0 0 0;">${title}</h1>
        </div>
        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
          ${content}
        </div>
        <div style="text-align: center; margin-top: 20px; color: #64748b; font-size: 12px;">
          &copy; ${new Date().getFullYear()} Olive Pizza. All rights reserved.<br>
          Rajnandgaon, Chhattisgarh
        </div>
      </div>
    `;
  }

  async sendMail(to: string, subject: string, html: string) {
    try {
      await this.transporter.sendMail({
        from: process.env.SMTP_FROM || '"Olive Pizza" <noreply@olivepizza.app>',
        to,
        subject,
        html,
      });
    } catch (error) {
      console.error(`Failed to send email to ${to}:`, error);
    }
  }

  // 1. Email Verification
  async sendVerificationEmail(to: string, code: string) {
    const html = this.wrapHtml('Verify Your Email', `
      <p>Welcome to Olive Pizza! Please verify your email address to complete your registration.</p>
      <div style="text-align: center; margin: 30px 0;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 5px; color: ${this.brandColor};">${code}</span>
      </div>
      <p>This code will expire in 15 minutes.</p>
    `);
    await this.sendMail(to, 'Verify Your Email - Olive Pizza', html);
  }

  // 2. Welcome Email
  async sendWelcomeEmail(to: string, name: string) {
    const html = this.wrapHtml('Welcome to Olive Pizza!', `
      <h3>Hi ${name},</h3>
      <p>Your account has been successfully created and verified! We're thrilled to have you.</p>
      <p>Start exploring our premium pizzas today.</p>
      <div style="text-align: center; margin-top: 20px;">
        <a href="https://olivepizza.in/menu" style="background-color: ${this.brandColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Order Now</a>
      </div>
    `);
    await this.sendMail(to, 'Welcome to Olive Pizza!', html);
  }

  // 3. Password Reset
  async sendPasswordReset(to: string, resetLink: string) {
    const html = this.wrapHtml('Password Reset', `
      <p>We received a request to reset your password.</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetLink}" style="background-color: ${this.brandColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Reset Password</a>
      </div>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `);
    await this.sendMail(to, 'Reset Your Password - Olive Pizza', html);
  }

  // Helper for rendering order details
  private renderOrderSummary(orderData: any) {
    const itemsHtml = orderData.items.map((item: any) => 
      `<tr>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0;">${item.quantity}x ${item.name}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">₹${item.price * item.quantity}</td>
      </tr>`
    ).join('');

    return `
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        ${itemsHtml}
        <tr>
          <td style="padding: 10px; font-weight: bold;">Subtotal</td>
          <td style="padding: 10px; font-weight: bold; text-align: right;">₹${orderData.totalAmount}</td>
        </tr>
        <tr>
          <td style="padding: 10px; color: #64748b;">Delivery Fee</td>
          <td style="padding: 10px; color: #64748b; text-align: right;">₹40</td>
        </tr>
        <tr>
          <td style="padding: 10px; font-size: 18px; font-weight: bold; color: ${this.brandColor}; border-top: 2px solid ${this.brandColor};">Total</td>
          <td style="padding: 10px; font-size: 18px; font-weight: bold; color: ${this.brandColor}; border-top: 2px solid ${this.brandColor}; text-align: right;">₹${orderData.totalAmount + 40}</td>
        </tr>
      </table>
    `;
  }

  // 4. Order Confirmation
  async sendOrderConfirmation(to: string, orderData: any) {
    const orderId = orderData.id.slice(-6).toUpperCase();
    const html = this.wrapHtml(`Order Confirmed! (#${orderId})`, `
      <p>Thank you for ordering with Olive Pizza. We've received your order and will start preparing it shortly.</p>
      ${this.renderOrderSummary(orderData)}
    `);
    await this.sendMail(to, `Order Confirmation #${orderId} - Olive Pizza`, html);
  }

  // 5. Order Accepted
  async sendOrderAccepted(to: string, orderId: string) {
    const html = this.wrapHtml(`Order Accepted (#${orderId})`, `
      <p>Great news! The kitchen has accepted your order and is getting everything ready.</p>
    `);
    await this.sendMail(to, `Order Accepted #${orderId}`, html);
  }

  // 6. Order Preparing
  async sendOrderPreparing(to: string, orderId: string) {
    const html = this.wrapHtml(`Order Preparing (#${orderId})`, `
      <p>Your pizza is in the oven! Our chefs are preparing your order with fresh ingredients.</p>
    `);
    await this.sendMail(to, `Order Preparing #${orderId}`, html);
  }

  // 7. Out For Delivery
  async sendOutForDelivery(to: string, orderId: string, deliveryPartnerName?: string) {
    const html = this.wrapHtml(`Out for Delivery! (#${orderId})`, `
      <p>Your order is on its way!</p>
      ${deliveryPartnerName ? `<p>Your delivery partner, <strong>${deliveryPartnerName}</strong>, is heading to your location.</p>` : ''}
      <div style="text-align: center; margin-top: 20px;">
        <a href="https://olivepizza.in/customer/dashboard" style="background-color: ${this.brandColor}; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Track Live on Map</a>
      </div>
    `);
    await this.sendMail(to, `Order Out For Delivery #${orderId}`, html);
  }

  // 8. Order Delivered
  async sendOrderDelivered(to: string, orderId: string) {
    const html = this.wrapHtml(`Order Delivered (#${orderId})`, `
      <p>Your order has been successfully delivered. Enjoy your meal!</p>
      <p>We'd love to hear your feedback. Please consider leaving a review on our platform.</p>
    `);
    await this.sendMail(to, `Order Delivered #${orderId}`, html);
  }

  // 9. Delivery Partner Invitation
  async sendDeliveryPartnerInvite(to: string, inviteCode: string) {
    const html = this.wrapHtml('Join Olive Delivery Fleet', `
      <p>You've been invited to join the Olive Pizza Delivery Fleet!</p>
      <p>Download the app and use the following invitation code to register your delivery partner account:</p>
      <div style="text-align: center; margin: 30px 0;">
        <span style="font-size: 24px; font-weight: bold; background-color: #f1f5f9; padding: 10px 20px; border-radius: 8px;">${inviteCode}</span>
      </div>
    `);
    await this.sendMail(to, 'Delivery Partner Invitation - Olive Pizza', html);
  }

  // 10. Owner Notifications
  async sendOwnerNotification(subject: string, message: string) {
    const ownerEmail = process.env.OWNER_EMAIL;
    if (!ownerEmail) return;

    const html = this.wrapHtml('Admin Alert', `
      <h3>${subject}</h3>
      <p>${message}</p>
    `);
    await this.sendMail(ownerEmail, `Admin Alert: ${subject}`, html);
  }
}

export const emailService = new EmailService();

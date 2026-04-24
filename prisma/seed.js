'use strict';

/**
 * Prisma seed — creates a demo tenant and SUPER_ADMIN user for development.
 * Run with: npm run seed
 *
 * LOGIN:  email: admin@demo.orderguard.app
 *         pass:  Admin@1234
 */

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Clean up existing seed data
  await prisma.call.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.emailConfig.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.tenant.deleteMany({});

  // Create demo tenant
  const tenant = await prisma.tenant.create({
    data: {
      businessName: 'Demo Shop BD',
      slug: 'demo-shop-bd',
      inboundEmail: 'demo-shop-bd@mail.orderguard.app',
      whatsappNumber: '01700000000',
      planType: 'PRO',
      isActive: true,
    },
  });
  console.log(`✅ Tenant created: ${tenant.businessName} (${tenant.id})`);

  // Create super admin user
  const passwordHash = await bcrypt.hash('Admin@1234', 12);
  const admin = await prisma.user.create({
    data: {
      tenantId: tenant.id,
      email: 'admin@demo.orderguard.app',
      passwordHash,
      fullName: 'Demo Admin',
      role: 'SUPER_ADMIN',
    },
  });
  console.log(`✅ Admin user created: ${admin.email}`);

  // Create sample orders
  const orders = await prisma.order.createMany({
    data: [
      {
        tenantId: tenant.id,
        externalId: 'ORD-001',
        customerName: 'রাহেলা বেগম',
        customerPhone: '01712345678',
        address: 'বাড়ি ৫, রোড ৩, ধানমণ্ডি, ঢাকা',
        productName: 'কটন শাড়ি (লাল)',
        quantity: 2,
        totalPrice: 1800.00,
        status: 'PENDING',
        callStatus: 'NOT_CALLED',
      },
      {
        tenantId: tenant.id,
        externalId: 'ORD-002',
        customerName: 'Karim Hossain',
        customerPhone: '01987654321',
        address: 'House 12, Gulshan-1, Dhaka',
        productName: 'Smartphone Case (iPhone 15)',
        quantity: 1,
        totalPrice: 350.00,
        status: 'CONFIRMED',
        callStatus: 'CONFIRMED',
      },
      {
        tenantId: tenant.id,
        externalId: 'ORD-003',
        customerName: 'Anonymous Customer',
        customerPhone: '01511111111',
        address: 'No address provided',
        productName: 'Wireless Earbuds',
        quantity: 5,
        totalPrice: 12500.00,
        status: 'FAKE',
        callStatus: 'NO_RESPONSE',
        notes: 'Suspicious: bulk order, unreachable after 3 attempts',
      },
    ],
  });
  console.log(`✅ ${orders.count} sample orders created`);

  console.log('\n🎉 Seed complete!');
  console.log('   Login: admin@demo.orderguard.app / Admin@1234');
}

main()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

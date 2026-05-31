const bcrypt = require('bcrypt');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const salt = await bcrypt.genSalt(10);
  const password_hash = await bcrypt.hash('Swata@123', salt);
  
  await prisma.driver.update({
    where: { phone: '9330776539' },
    data: { password_hash }
  });
  console.log("Password updated successfully!");
}

main().catch(console.error).finally(() => prisma.$disconnect());

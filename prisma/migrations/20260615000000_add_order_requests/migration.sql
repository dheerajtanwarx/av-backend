-- CreateTable
CREATE TABLE `order_requests` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `addressId` INTEGER NULL,
    `status` ENUM('PENDING_APPROVAL', 'APPROVED', 'PAYMENT_SUBMITTED', 'PAID', 'CONFIRMED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING_APPROVAL',
    `totalAmount` DECIMAL(10, 2) NOT NULL,
    `upiIdSnapshot` VARCHAR(191) NULL,
    `paymentRef` VARCHAR(191) NULL,
    `paymentProofUrl` VARCHAR(191) NULL,
    `customerNote` TEXT NULL,
    `adminNote` TEXT NULL,
    `rejectionReason` TEXT NULL,
    `orderId` INTEGER NULL,
    `approvedAt` DATETIME(3) NULL,
    `paymentSubmittedAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `order_requests_orderId_key`(`orderId`),
    INDEX `order_requests_userId_idx`(`userId`),
    INDEX `order_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_request_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `requestId` INTEGER NOT NULL,
    `variantId` INTEGER NOT NULL,
    `size` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(10, 2) NOT NULL,
    `totalPrice` DECIMAL(10, 2) NOT NULL,
    `nameSnapshot` VARCHAR(191) NOT NULL,
    `colorSnapshot` VARCHAR(191) NOT NULL,

    INDEX `order_request_items_requestId_idx`(`requestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `order_requests` ADD CONSTRAINT `order_requests_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_requests` ADD CONSTRAINT `order_requests_addressId_fkey` FOREIGN KEY (`addressId`) REFERENCES `addresses`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_requests` ADD CONSTRAINT `order_requests_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_request_items` ADD CONSTRAINT `order_request_items_requestId_fkey` FOREIGN KEY (`requestId`) REFERENCES `order_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_request_items` ADD CONSTRAINT `order_request_items_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


import { z } from 'zod';
import { nanoid } from 'nanoid';
import { dokuService } from '../services/dokuService.js';
import config from '../config/index.js';

/** Validation schema for a bank disbursement. */
const disburseSchema = z.object({
  bankCode: z.string().min(2).max(16),
  bankAccountNo: z.string().min(4).max(32),
  beneficiaryName: z.string().min(1).max(64),
  amount: z.coerce.number().positive().max(1_000_000_000),
  currency: z.string().default('IDR'),
  remark: z.string().max(140).optional(),
  partnerReferenceNo: z.string().max(64).optional(),
});

/**
 * POST /api/disbursements
 * Transfer funds to a bank account via DOKU.
 */
export async function createDisbursement(req, res, next) {
  try {
    const parsed = disburseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const input = parsed.data;
    const partnerReferenceNo =
      input.partnerReferenceNo || `DSB-${Date.now()}-${nanoid(6).toUpperCase()}`;

    const dokuRes = await dokuService.disburseToBank({
      partnerReferenceNo,
      bankCode: input.bankCode,
      bankAccountNo: input.bankAccountNo,
      beneficiaryName: input.beneficiaryName,
      amount: { value: input.amount, currency: input.currency },
      remark: input.remark,
    });

    if (dokuRes.responseCode && !/^(2|SUCCESS)/i.test(String(dokuRes.responseCode))) {
      return res.status(422).json({
        success: false,
        error: 'DOKU_ERROR',
        message: dokuRes.responseMessage || 'DOKU rejected the disbursement',
        dokuResponse: dokuRes,
      });
    }

    res.status(201).json({
      success: true,
      data: {
        partnerReferenceNo,
        dokuReferenceNo: dokuRes.referenceNo,
        bankCode: input.bankCode,
        bankAccountNo: input.bankAccountNo,
        beneficiaryName: input.beneficiaryName,
        amount: { value: input.amount, currency: input.currency },
        status: 'PENDING',
        mockMode: config.mockMode,
        dokuResponse: dokuRes,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/disbursements/inquiry
 * Look up a bank account holder name before transferring (best-effort).
 */
export async function inquireBankAccount(req, res, next) {
  try {
    const schema = z.object({
      bankCode: z.string().min(2).max(16),
      bankAccountNo: z.string().min(4).max(32),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    let accountName;
    if (config.mockMode) {
      accountName = 'BUDI SANTOSO';
    } else {
      const dokuRes = await dokuService.inquireBankAccount(parsed.data);
      if (dokuRes.responseCode && !/^(2|SUCCESS)/i.test(String(dokuRes.responseCode))) {
        return res.status(422).json({
          success: false,
          error: 'DOKU_ERROR',
          message: dokuRes.responseMessage || 'DOKU rejected the inquiry',
          dokuResponse: dokuRes,
        });
      }
      accountName = dokuRes.accountName;
      if (!accountName) {
        return res.status(404).json({
          success: false,
          error: 'ACCOUNT_NOT_FOUND',
          message: 'DOKU did not return an account name for these details',
        });
      }
    }

    res.json({
      success: true,
      data: { ...parsed.data, accountName, mockMode: config.mockMode },
    });
  } catch (err) {
    next(err);
  }
}

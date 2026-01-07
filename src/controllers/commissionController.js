const prisma = require('../prismaClient');

function validateWeightBrackets(brackets) {
  if (!Array.isArray(brackets) || brackets.length === 0) {
    return { valid: false, message: 'At least one weight bracket is required' };
  }
  // Sort by minKg (do not mutate input)
  const sorted = brackets.map((b) => ({ ...b })).sort((a, b) => a.minKg - b.minKg);
  for (let i = 0; i < sorted.length; ++i) {
    const b = sorted[i];
    if (b.minKg == null || isNaN(b.minKg) || b.minKg < 0)
      return { valid: false, message: `Invalid minKg for bracket ${i + 1}` };
    if (b.charge == null || isNaN(b.charge) || b.charge < 0)
      return { valid: false, message: `Invalid charge for bracket ${i + 1}` };
    if (b.maxKg != null && (isNaN(b.maxKg) || b.maxKg <= b.minKg))
      return { valid: false, message: `maxKg must be > minKg for bracket ${i + 1}` };
    if (i > 0) {
      const prev = sorted[i - 1];
      // Gaps allowed, but overlap not allowed
      if (prev.maxKg != null) {
        if (b.minKg < prev.maxKg) {
          return {
            valid: false,
            message: `Overlap between ${prev.minKg}-${prev.maxKg}kg and ${b.minKg}-${
              b.maxKg || '∞'
            }kg`,
          };
        }
      }
    }
    // Only last can be maxKg == null
    if (b.maxKg == null && i !== sorted.length - 1) {
      return {
        valid: false,
        message: 'Only last bracket can have no maxKg (infinity bracket)',
      };
    }
  }
  return { valid: true };
}

exports.validateWeightBrackets = validateWeightBrackets;

function mapWeightBrackets(weightBrackets) {
  const arr = Array.isArray(weightBrackets) ? weightBrackets : [];
  return arr
    .slice()
    .sort((a, b) => Number(a.minKg || 0) - Number(b.minKg || 0))
    .map((b) => ({
      minKg: b.minKg,
      maxKg: b.maxKg === undefined ? null : b.maxKg,
      charge: b.chargePkr,
    }));
}

function mapCommissionConfigToApi(cfg, { includeShipperDetails = false } = {}) {
  if (!cfg) return null;
  const base = {
    _id: cfg.id,
    id: cfg.id,
    shipper: cfg.shipperId,
    type: cfg.type,
    value: cfg.value,
    riderType: cfg.riderType,
    riderValue: cfg.riderValue,
    returnCharge: cfg.returnCharge ?? 0,
    weightBrackets: mapWeightBrackets(cfg.weightBrackets),
  };

  if (includeShipperDetails && cfg.shipper) {
    base.shipper = {
      _id: cfg.shipperId,
      id: cfg.shipperId,
      name: cfg.shipper.name,
      email: cfg.shipper.email,
    };
  }

  return base;
}

function normalizeWeightCharge(bracket) {
  if (!bracket) return null;
  const minKg = Number(bracket.minKg);
  const maxKgRaw = bracket.maxKg;
  const maxKg =
    maxKgRaw === null || maxKgRaw === undefined || maxKgRaw === ''
      ? null
      : Number(maxKgRaw);
  const chargePkr = Number(bracket.charge || 0);
  return { minKg, maxKg, chargePkr };
}

function mapRiderCommissionConfigToApi(cfg, { includeRiderDetails = false } = {}) {
  if (!cfg) return null;
  const rules = Array.isArray(cfg.rules)
    ? cfg.rules.map((r) => ({
        _id: r.id,
        status: r.status,
        type: r.type,
        value: r.value,
      }))
    : [];

  const base = {
    _id: cfg.id,
    id: cfg.id,
    rider: cfg.riderId,
    type: cfg.type,
    value: cfg.value,
    rules,
  };

  if (includeRiderDetails && cfg.rider) {
    base.rider = {
      _id: cfg.riderId,
      id: cfg.riderId,
      name: cfg.rider.name,
      email: cfg.rider.email,
    };
  }

  return base;
}

exports.getConfigs = async (req, res, next) => {
  try {
    const configs = await prisma.commissionConfig.findMany({
      include: {
        shipper: { select: { id: true, name: true, email: true } },
        weightBrackets: true,
      },
    });

    const apiConfigs = configs.map((cfg) =>
      mapCommissionConfigToApi(cfg, { includeShipperDetails: true }),
    );

    res.json(apiConfigs);
  } catch (error) {
    next(error);
  }
};

exports.upsertConfig = async (req, res, next) => {
  try {
    const {
      shipperId,
      type,
      value,
      riderType,
      riderValue,
      weightCharges,
      returnCharge,
    } = req.body;

    if (!shipperId || !type || value === undefined) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const shipperIdNum = Number(shipperId);
    if (!Number.isInteger(shipperIdNum) || shipperIdNum <= 0) {
      return res.status(400).json({ message: 'Invalid shipperId' });
    }

    const mainData = {
      type,
      value: Number(value),
    };

    if (riderType !== undefined) mainData.riderType = riderType;
    if (riderValue !== undefined) mainData.riderValue = Number(riderValue);
    if (returnCharge !== undefined) {
      const rcNum = Number(returnCharge);
      mainData.returnCharge = Number.isNaN(rcNum) ? 0 : rcNum;
    }

    let updated;

    await prisma.$transaction(async (tx) => {
      const existing = await tx.commissionConfig.findUnique({
        where: { shipperId: shipperIdNum },
        include: { weightBrackets: true },
      });

      const normalizedBrackets = Array.isArray(weightCharges)
        ? weightCharges.map(normalizeWeightCharge).filter(Boolean)
        : null;

      if (!existing) {
        const createData = {
          shipperId: shipperIdNum,
          ...mainData,
        };

        if (normalizedBrackets && normalizedBrackets.length) {
          createData.weightBrackets = {
            create: normalizedBrackets.map((b) => ({
              minKg: b.minKg,
              maxKg: b.maxKg,
              chargePkr: b.chargePkr,
            })),
          };
        }

        updated = await tx.commissionConfig.create({
          data: createData,
          include: { weightBrackets: true },
        });
      } else {
        if (normalizedBrackets) {
          await tx.weightBracket.deleteMany({
            where: { commissionConfigId: existing.id },
          });
          if (normalizedBrackets.length) {
            await tx.weightBracket.createMany({
              data: normalizedBrackets.map((b) => ({
                commissionConfigId: existing.id,
                minKg: b.minKg,
                maxKg: b.maxKg,
                chargePkr: b.chargePkr,
              })),
            });
          }
        }

        updated = await tx.commissionConfig.update({
          where: { id: existing.id },
          data: mainData,
          include: { weightBrackets: true },
        });
      }
    });

    res.json(mapCommissionConfigToApi(updated));
  } catch (error) {
    next(error);
  }
};

exports.getRiderConfigs = async (req, res, next) => {
  try {
    const configs = await prisma.riderCommissionConfig.findMany({
      include: {
        rider: { select: { id: true, name: true, email: true } },
        rules: true,
      },
    });

    const apiConfigs = configs.map((cfg) =>
      mapRiderCommissionConfigToApi(cfg, { includeRiderDetails: true }),
    );

    res.json(apiConfigs);
  } catch (error) {
    next(error);
  }
};

exports.upsertRiderConfig = async (req, res, next) => {
  try {
    const { riderId, type, value, rules } = req.body;

    if (!riderId) {
      return res.status(400).json({ message: 'Missing fields' });
    }

    const riderIdNum = Number(riderId);
    if (!Number.isInteger(riderIdNum) || riderIdNum <= 0) {
      return res.status(400).json({ message: 'Invalid riderId' });
    }

    const updateData = {};
    if (type !== undefined && value !== undefined) {
      updateData.type = type;
      updateData.value = Number(value);
    }

    const normalizedRules = Array.isArray(rules)
      ? rules
          .filter((r) => r && r.status && r.type && r.value !== undefined)
          .map((r) => ({
            status: String(r.status).toUpperCase(),
            type: r.type,
            value: Number(r.value),
          }))
      : [];

    let result;

    await prisma.$transaction(async (tx) => {
      let existing = await tx.riderCommissionConfig.findUnique({
        where: { riderId: riderIdNum },
      });

      if (!existing) {
        result = await tx.riderCommissionConfig.create({
          data: {
            riderId: riderIdNum,
            type: updateData.type || 'FLAT',
            value: updateData.value ?? 0,
            rules: normalizedRules.length
              ? {
                  create: normalizedRules.map((r) => ({
                    status: r.status,
                    type: r.type,
                    value: r.value,
                  })),
                }
              : undefined,
          },
          include: { rules: true },
        });
      } else {
        if (normalizedRules.length) {
          await tx.riderCommissionRule.deleteMany({
            where: { configId: existing.id },
          });
          await tx.riderCommissionRule.createMany({
            data: normalizedRules.map((r) => ({
              configId: existing.id,
              status: r.status,
              type: r.type,
              value: r.value,
            })),
          });
        }

        result = await tx.riderCommissionConfig.update({
          where: { id: existing.id },
          data: updateData,
          include: { rules: true },
        });
      }
    });

    res.json(mapRiderCommissionConfigToApi(result));
  } catch (error) {
    next(error);
  }
};

// GET /api/commission/:shipperId - CEO/MANAGER only
exports.getConfigByShipper = async (req, res, next) => {
  try {
    const shipperIdRaw = req.params.shipperId;
    if (!shipperIdRaw) {
      return res.status(400).json({ message: 'shipperId required' });
    }

    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return res.status(400).json({ message: 'Invalid shipperId' });
    }

    const cfg = await prisma.commissionConfig.findUnique({
      where: { shipperId },
      include: { weightBrackets: true },
    });

    if (!cfg) {
      return res
        .status(404)
        .json({ message: 'No commission config found for this shipper' });
    }

    console.log(
      '[Commission] GET config for shipper',
      shipperId,
      'returnCharge =',
      cfg.returnCharge,
    );

    res.json(mapCommissionConfigToApi(cfg));
  } catch (err) {
    next(err);
  }
};

// PUT /api/commission/:shipperId - CEO/MANAGER only
exports.putConfigByShipper = async (req, res, next) => {
  try {
    const shipperIdRaw = req.params.shipperId;
    if (!shipperIdRaw) {
      return res.status(400).json({ message: 'shipperId required' });
    }

    const shipperId = Number(shipperIdRaw);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return res.status(400).json({ message: 'Invalid shipperId' });
    }

    const { type, value, weightBrackets, returnCharge } = req.body;
    if (!type || typeof value !== 'number') {
      return res.status(400).json({ message: 'type and value required' });
    }

    const valRes = validateWeightBrackets(weightBrackets || []);
    if (!valRes.valid) {
      return res.status(400).json({ message: valRes.message });
    }

    const normalizedBrackets = (weightBrackets || [])
      .map((b) => ({
        minKg: Number(b.minKg),
        maxKg:
          b.maxKg === null || b.maxKg === undefined || b.maxKg === ''
            ? null
            : Number(b.maxKg),
        chargePkr: Number(b.charge || 0),
      }))
      .filter((b) => !Number.isNaN(b.minKg) && !Number.isNaN(b.chargePkr));

    let result;

    console.log(
      '[Commission] PUT body for shipper',
      shipperId,
      'payload.returnCharge =',
      returnCharge,
    );

    await prisma.$transaction(async (tx) => {
      let existing = await tx.commissionConfig.findUnique({
        where: { shipperId },
      });

      if (!existing) {
        result = await tx.commissionConfig.create({
          data: {
            shipperId,
            type,
            value,
            returnCharge:
              returnCharge === undefined || returnCharge === null
                ? 0
                : Number.isNaN(Number(returnCharge))
                  ? 0
                  : Number(returnCharge),
            weightBrackets: {
              create: normalizedBrackets.map((b) => ({
                minKg: b.minKg,
                maxKg: b.maxKg,
                chargePkr: b.chargePkr,
              })),
            },
          },
          include: { weightBrackets: true },
        });
      } else {
        await tx.weightBracket.deleteMany({
          where: { commissionConfigId: existing.id },
        });

        if (normalizedBrackets.length) {
          await tx.weightBracket.createMany({
            data: normalizedBrackets.map((b) => ({
              commissionConfigId: existing.id,
              minKg: b.minKg,
              maxKg: b.maxKg,
              chargePkr: b.chargePkr,
            })),
          });
        }

        const updateData = { type, value };
        if (returnCharge !== undefined) {
          const rcNum = Number(returnCharge);
          updateData.returnCharge = Number.isNaN(rcNum) ? 0 : rcNum;
        }

        result = await tx.commissionConfig.update({
          where: { id: existing.id },
          data: updateData,
          include: { weightBrackets: true },
        });
      }
    });

    console.log(
      '[Commission] PUT saved for shipper',
      shipperId,
      'stored returnCharge =',
      result.returnCharge,
    );

    res.json(mapCommissionConfigToApi(result));
  } catch (err) {
    next(err);
  }
};

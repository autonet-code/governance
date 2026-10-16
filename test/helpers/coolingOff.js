const { time } = require("@nomicfoundation/hardhat-network-helpers");

// A project can't be signed until its cooling-off has passed.
async function passCoolingOff(project) {
    const ends = await project.coolingOffPeriodEnds();
    if (ends >= BigInt(await time.latest())) await time.increaseTo(ends + 1n);
}

module.exports = { passCoolingOff };

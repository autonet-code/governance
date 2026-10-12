const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Every economy belongs to a DAO, so a project can't be signed until its cooling-off
// (a full proposal lifecycle plus a buffer) has passed.
async function passCoolingOff(project) {
    const ends = await project.coolingOffPeriodEnds();
    if (ends >= BigInt(await time.latest())) await time.increaseTo(ends + 1n);
}

module.exports = { passCoolingOff };

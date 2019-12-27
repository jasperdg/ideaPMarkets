pragma solidity 0.4.26;

import 'IMarket.sol';

contract IdeaMarketResolver {
  bool invalid = false;
  uint[] resolution;
  uint256 binaryUpperBound;
  IMarket market;
	// IdeaMarket ideaMarket TODO: Make import idea markets and link to the market this resolver is linked too
  public constructor(
    IMarket _market,
    // IdeaMarket _ideaMarket, // TODO
    uint256 _binaryUpperBound
  ) {
    market = _market;
    binaryUpperBound = _binaryUpperBound;
    // ideaMarket = _ideaMarket // TODO

  }
  function resolve() public {
    // require(ideaMarket.isEnded());
    require(market.isFinalized());

    //uint256 data = ideaMarket.getMarketMetric();
    uint256 data = 10; // Placeholder

    // Check if the market metric is lower or higher than the upper bound
    if (data < binaryUpperBound) {
      resolution = [10000, 0]; // Resolute no
    } else if (data > binaryUpperBonud){
      resolution = [0, 10000]; // Resolute yes
    } else {
      resolution = [5000, 5000];
      invalid = true;
    }

    market.resolve(resolution, invalid);
  }

}

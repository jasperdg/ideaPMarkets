pragma solidity 0.4.26;

import 'IMarket.sol';
// import 'IdeaMarket.sol'; // import idea market contract once we have access to them

contract IdeaMarketResolver {
  bool invalid = false;
  uint[] resolution;
  uint256 metricUpperBound;
  IMarket market;
	// IdeaMarket ideaMarket TODO: import idea markets and link to the market this resolver is linked too
  public constructor(
    IMarket _market,
    // IdeaMarket _ideaMarket, // TODO
    uint256 _binaryUpperBound
  ) {
    market = _market;
    metricUpperBound = _metricUpperBound;
    // ideaMarket = _ideaMarket // TODO

  }
  function resolve() public {
    // require(ideaMarket.isEnded());
    require(market.isFinalized());

    //uint256 data = ideaMarket.getMarketMetric();
    uint256 data = 10; // Placeholder

    // Check if the market metric is lower or higher than the upper bound
    if (data < metricUpperBound) {
      resolution = [10000, 0]; // Resolute no
    } else if (data > metricUpperBound){
      resolution = [0, 10000]; // Resolute yes
    } else {
      resolution = [5000, 5000];
      invalid = true;
    }

    market.resolve(resolution, invalid);
  }

}

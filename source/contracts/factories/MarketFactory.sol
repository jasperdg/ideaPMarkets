pragma solidity 0.4.26;

import 'IMarket.sol';
import 'IController.sol';
import 'libraries/Delegator.sol';
import 'libraries/token/ERC20.sol';
import 'IdeaMarketResolver.sol';

contract MarketFactory {
  function createMarket(IController _controller, IUniverse _universe, uint256 _metricUpperBound, address _ideaMarket, uint256 _endTime, uint256 _feeDivisor, ERC20 _denominationToken, address _oracle, address _sender, uint256 _numOutcomes, uint256 _numTicks) public returns (IMarket _market) {
    Delegator _delegator = new Delegator(_controller, "Market");
    _market = IMarket(_delegator);
    IdeaMarketResolver ideaMarketResolver = new IdeaMarketResolver(_market,  _metricUpperBound, _ideaMarket);
    _market.initialize(_universe, _endTime, _feeDivisor, _denominationToken, address(ideaMarketResolver), _sender, _numOutcomes, _numTicks);
    return _market;
  }
}

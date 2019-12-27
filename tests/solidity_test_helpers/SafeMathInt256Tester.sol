pragma solidity 0.4.26;

import 'libraries/math/SafeMathInt256.sol';


contract SafeMathInt256Tester {
  using SafeMathInt256 for int256;

  function mul(int256 _a, int256 _b) public view returns (int256) {
    return _a.mul(_b);
  }

  function div(int256 _a, int256 _b) public view returns (int256) {
    return _a.div(_b);
  }

  function sub(int256 _a, int256 _b) public view returns (int256) {
    return _a.sub(_b);
  }

  function add(int256 _a, int256 _b) public view returns (int256) {
    return _a.add(_b);
  }

  function min(int256 _a, int256 _b) public view returns (int256) {
    return _a.min(_b);
  }

  function max(int256 _a, int256 _b) public view returns (int256) {
    return _a.max(_b);
  }

  function getInt256Min() public view returns (int256) {
    return SafeMathInt256.getInt256Min();
  }

  function getInt256Max() public view returns (int256) {
    return SafeMathInt256.getInt256Max();
  }
}

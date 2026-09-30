{
  // MewLock x Lithos: one lock position.
  //
  // Holds the owner's LIT plus the reward the campaign reserved for it at lock
  // time (tokens(0) is the campaign's position marker). Only the owner can
  // spend it, and only once the unlock height is reached.
  //
  // Deliberately arithmetic-free: nothing here can overflow or fail on a
  // well-formed box, so a position can never get stuck. The campaign's lock
  // path checks R4 and R5 are present before it creates one.
  //
  // R4: GroupElement  owner
  // R5: Int           unlock height
  // R6..R8 (principal, reward, tier) are informational here; the campaign
  // validates them when the position is created.
  proveDlog(SELF.R4[GroupElement].get) && sigmaProp(HEIGHT >= SELF.R5[Int].get)
}

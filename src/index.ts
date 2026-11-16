import Resolver from '@forge/resolver'
import { registerPokerResolvers } from './resolvers/poker-resolvers'

const resolver = registerPokerResolvers(new Resolver())

export const handler = resolver.getDefinitions()
